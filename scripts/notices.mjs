// THIRD_PARTY_NOTICES.md from the CycloneDX SBOM (npm run sbom first).
import { readFileSync, writeFileSync } from 'node:fs';

const bom = JSON.parse(readFileSync('docs/sbom.cdx.json', 'utf8'));
const lic = (c) => (c.licenses ?? []).map((l) => l.license?.id ?? l.license?.name ?? l.expression).filter(Boolean).join(' OR ') || 'not stated';
const rows = (bom.components ?? []).filter((c) => !String(c['bom-ref'] ?? c.name).startsWith('@parashurama/')) // our own workspace packages
  .map((c) => [c.group ? `${c.group}/${c.name}` : c.name, c.version, lic(c)]).sort((a, b) => a[0].localeCompare(b[0]));
const by = {}; rows.forEach(([, , l]) => (by[l] = (by[l] ?? 0) + 1));
writeFileSync('THIRD_PARTY_NOTICES.md', `# Third-party notices

Production dependencies of PARASHURAMA, generated from \`docs/sbom.cdx.json\` (CycloneDX) by \`npm run notices\`. Development-only tools are not shipped and are not listed.

Licence summary: ${Object.entries(by).sort((a, b) => b[1] - a[1]).map(([l, n]) => `${l} (${n})`).join(', ')}.

| Package | Version | Licence |
|---|---|---|
${rows.map((r) => `| ${r.join(' | ')} |`).join('\n')}
`);
console.log(`THIRD_PARTY_NOTICES.md: ${rows.length} packages`);
