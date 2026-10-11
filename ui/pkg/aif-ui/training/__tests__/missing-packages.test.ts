import { describe, expect, it } from 'vitest';
import { missingPackages } from '../preflight';

const TORCH_ONLY = 'dp.apps.rancher.io/containers/pytorch';

describe('missingPackages', () => {
  it('warns of imports a PyTorch-only image does not have', () => {
    expect(missingPackages(TORCH_ONLY, 'import transformers\nfrom peft import LoraConfig\n')).toEqual(['transformers', 'peft']);
  });

  it('does not warn for a script that installs its own packages', () => {
    expect(missingPackages(TORCH_ONLY, 'subprocess.run([sys.executable, "-m", "pip", "install", "peft"])\nimport peft\n')).toEqual([]);
    expect(missingPackages(TORCH_ONLY, 'subprocess.run([sys.executable, "-m", "ensurepip", "--user"])\nimport transformers\n')).toEqual([]);
    expect(missingPackages(TORCH_ONLY, 'os.system("pip install transformers")\nimport transformers\n')).toEqual([]);
  });

  it('says nothing for an image that ships them', () => {
    expect(missingPackages('nvcr.io/nvidia/pytorch', 'import transformers\n')).toEqual([]);
  });
});
