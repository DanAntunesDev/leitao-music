// Hook do electron-builder: no Windows, grava ícone + metadados no .exe com
// `resedit` (JS puro). Assim o build do .exe funciona em Linux sem Wine.
const fs = require('node:fs');
const path = require('node:path');

exports.default = async function afterPack(ctx) {
  if (ctx.electronPlatformName !== 'win32') return;

  const { NtExecutable, NtExecutableResource, Data, Resource } = await import('resedit');
  const pkg = ctx.packager.appInfo;
  const exePath = path.join(ctx.appOutDir, `${(ctx.packager.appInfo.productFilename && ctx.packager.platformSpecificBuildOptions.executableName || ctx.packager.config.executableName || ctx.packager.appInfo.productFilename)}.exe`);
  const icoPath = path.join(ctx.packager.projectDir, 'assets', 'icon.ico');

  const exe = NtExecutable.from(fs.readFileSync(exePath));
  const res = NtExecutableResource.from(exe);

  // ícone: substitui o grupo de ícones padrão do Electron
  const iconFile = Data.IconFile.from(fs.readFileSync(icoPath));
  const groups = Resource.IconGroupEntry.fromEntries(res.entries);
  const groupId = groups[0]?.id ?? 1;
  const lang = groups[0]?.lang ?? 1033;
  Resource.IconGroupEntry.replaceIconsForResource(res.entries, groupId, lang, iconFile.icons.map((i) => i.data));

  // metadados (aparecem em Propriedades → Detalhes e no Gerenciador de Tarefas)
  const versions = Resource.VersionInfo.fromEntries(res.entries);
  const vi = versions[0] ?? Resource.VersionInfo.createEmpty();
  const [maj, min, patch] = pkg.version.split('.').map(Number);
  vi.setFileVersion(maj, min, patch, 0, 1033);
  vi.setProductVersion(maj, min, patch, 0, 1033);
  vi.setStringValues({ lang: 1033, codepage: 1200 }, {
    FileDescription: pkg.productName,
    ProductName: pkg.productName,
    CompanyName: 'Daniel Antunes',
    LegalCopyright: '© 2026 Daniel Antunes',
    InternalName: (ctx.packager.appInfo.productFilename && ctx.packager.platformSpecificBuildOptions.executableName || ctx.packager.config.executableName || ctx.packager.appInfo.productFilename),
    OriginalFilename: `${(ctx.packager.appInfo.productFilename && ctx.packager.platformSpecificBuildOptions.executableName || ctx.packager.config.executableName || ctx.packager.appInfo.productFilename)}.exe`,
    FileVersion: pkg.version,
    ProductVersion: pkg.version,
  });
  vi.outputToResourceEntries(res.entries);

  res.outputResource(exe);
  fs.writeFileSync(exePath, Buffer.from(exe.generate()));
  console.log(`  • ícone e metadados gravados em ${path.basename(exePath)} (resedit)`);
};
