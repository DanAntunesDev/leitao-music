import type { BridgeApi } from '../main/shared';

declare global {
  interface Window { leitao: BridgeApi }
}

const redirect = new URLSearchParams(location.search).get('redirect') ?? '';
const input = document.getElementById('cid') as HTMLInputElement;
const err = document.getElementById('err')!;

document.getElementById('redirect')!.textContent = redirect;
document.getElementById('copy')!.addEventListener('click', () => navigator.clipboard.writeText(redirect));

window.leitao.getClientId().then((id) => (input.value = id));

async function save() {
  err.textContent = '';
  const ok = await window.leitao.saveClientId(input.value);
  if (!ok) err.textContent = 'Client ID inválido (são 32 caracteres hex).';
}

document.getElementById('save')!.addEventListener('click', save);
input.addEventListener('keydown', (e) => e.key === 'Enter' && save());
