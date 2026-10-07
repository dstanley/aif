import pytest

from rancher_ai.volumes import SHA256_NAME, _ExecReader, _progress, volume_path


def test_a_path_stays_inside_the_volume():
    assert volume_path("hf/hub/x") == "/data/hf/hub/x"
    assert volume_path("/./a//b/") == "/data/a/b"
    assert volume_path("") == "/data"
    with pytest.raises(ValueError):
        volume_path("hf/../../etc/passwd")


def test_a_hugging_face_blob_is_named_by_its_sha256():
    assert SHA256_NAME.match("dd924a11b4c220f385b51ffa522daea7c9f3d850e31b162bb5661df483c6d3ee")
    assert not SHA256_NAME.match("07bfe0640cb5a0037f9322287fbfc682806cf672")  # git's SHA-1 of a small file


class FakeWS:
    """An exec stream that delivers its stdout in the chunks given, then closes."""

    def __init__(self, chunks):
        self.chunks, self.ready = list(chunks), None

    def is_open(self):
        return bool(self.chunks) or self.ready is not None

    def update(self, timeout=0):
        if self.ready is None and self.chunks:
            self.ready = self.chunks.pop(0)

    def peek_stdout(self):
        return self.ready is not None

    def read_stdout(self):
        out, self.ready = self.ready, None
        return out


def test_the_exec_reader_hands_tar_exactly_the_bytes_it_asks_for():
    seen = []
    r = _ExecReader(FakeWS([b"abc", b"defgh", b"ij"]), seen.append)
    assert r.read(4) == b"abcd"
    assert r.read(4) == b"efgh"
    assert r.read(4) == b"ij"  # the stream ended
    assert r.read(4) == b""
    assert sum(seen) == 10


def test_the_exec_reader_streams_a_folder_through_tarfile(tmp_path):
    import io
    import tarfile
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as t:
        for name, data in (("refs/main", b"989aa79"), ("refs/sub/x", b"y" * 5000)):
            info = tarfile.TarInfo(name)
            info.size = len(data)
            t.addfile(info, io.BytesIO(data))
    raw = buf.getvalue()
    chunks = [raw[i:i + 777] for i in range(0, len(raw), 777)]
    with tarfile.open(fileobj=_ExecReader(FakeWS(chunks)), mode="r|") as t:
        t.extractall(tmp_path, filter="data")
    assert (tmp_path / "refs" / "main").read_bytes() == b"989aa79"
    assert len((tmp_path / "refs" / "sub" / "x").read_bytes()) == 5000


def test_progress_prints_every_tenth_of_a_known_size(capsys):
    on = _progress(1000, quiet=False)
    for _ in range(10):
        on(100)
    lines = capsys.readouterr().out.strip().splitlines()
    assert len(lines) == 10 and lines[-1].strip().startswith("100%")
    on2 = _progress(1000, quiet=True)
    on2(1000)
    assert capsys.readouterr().out == ""
