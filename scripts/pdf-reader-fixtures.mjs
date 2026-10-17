// Original, synthetic fixtures: no downloaded paper content or third-party code.
// node scripts/pdf-reader-fixtures.mjs [output directory]
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { deflateSync } from "node:zlib";

const output = resolve(process.argv[2] || "test-assets/pdf-reader");
mkdirSync(output, { recursive: true });

function createPdf(name, count, scans = new Set()) {
  const objects = [];
  const add = (body) => { objects.push(Buffer.isBuffer(body) ? body : Buffer.from(body)); return objects.length; };
  const stream = (body, attributes = "") => {
    const data = Buffer.isBuffer(body) ? body : Buffer.from(body);
    return add(Buffer.concat([Buffer.from(`<< /Length ${data.length} ${attributes} >>\nstream\n`), data, Buffer.from("\nendstream")]));
  };
  const catalog = add("");
  const root = add("");
  const font = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  const bitmap = Buffer.alloc(96 * 128);
  for (let y = 0; y < 128; y++) for (let x = 0; x < 96; x++) bitmap[y * 96 + x] = y % 14 < 2 && x > 7 && x < 86 ? 45 : 247;
  const image = stream(deflateSync(bitmap), "/Type /XObject /Subtype /Image /Width 96 /Height 128 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode");
  const pages = [];
  for (let number = 1; number <= count; number++) {
    const scan = scans.has(number);
    const lines = [`BT /F1 16 Tf 42 742 Td (Two-column paper - physical page ${number}) Tj ET`];
    for (let row = 0; row < 32; row++) {
      const y = 702 - row * 17;
      lines.push(`BT /F1 10 Tf 42 ${y} Td (Left ${number}.${row + 1}: selectable research text.) Tj ET`);
      lines.push(`BT /F1 10 Tf 316 ${y} Td (Right ${number}.${row + 1}: bilingual reader test.) Tj ET`);
    }
    lines.push("0.6 0.4 0.2 RG 42 100 530 30 re S BT /F1 11 Tf 52 110 Td (Figure 1. Original vector figure and caption.) Tj ET");
    const content = stream(scan ? "q 560 0 0 730 26 30 cm /Scan Do Q" : lines.join("\n"));
    const link = add(`<< /Type /Annot /Subtype /Link /Rect [42 735 310 760] /Border [0 0 1] /A << /S /GoTo /D [${root + 0} /Fit] >> >>`);
    const external = add("<< /Type /Annot /Subtype /Link /Rect [42 90 572 133] /Border [0 0 1] /A << /S /URI /URI (https://mozilla.github.io/pdf.js/) >> >>");
    pages.push(add(`<< /Type /Page /Parent ${root} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> /XObject << /Scan ${image} 0 R >> >> /Contents ${content} 0 R ${scan ? "" : `/Annots [${link} 0 R ${external} 0 R]`} >>`));
    // Explicit physical destination to the final page is filled after IDs are known.
    objects[link - 1] = Buffer.from(`<< /Type /Annot /Subtype /Link /Rect [42 735 310 760] /Border [0 0 1] /Dest [${number === count ? pages[0] : 0} 0 R /Fit] >>`);
  }
  for (let i = 0; i < objects.length; i++) {
    const text = objects[i].toString();
    if (text.includes("/Dest [0 0 R")) objects[i] = Buffer.from(text.replace("/Dest [0 0 R", `/Dest [${pages.at(-1)} 0 R`));
  }
  const outlines = add("");
  const first = add(`<< /Title (Start) /Parent ${outlines} 0 R /Dest [${pages[0]} 0 R /Fit] /Next ${outlines + 2} 0 R >>`);
  const last = add(`<< /Title (Final physical page) /Parent ${outlines} 0 R /Dest [${pages.at(-1)} 0 R /Fit] /Prev ${first} 0 R >>`);
  objects[outlines - 1] = Buffer.from(`<< /Type /Outlines /First ${first} 0 R /Last ${last} 0 R /Count 2 >>`);
  objects[catalog - 1] = Buffer.from(`<< /Type /Catalog /Pages ${root} 0 R /Outlines ${outlines} 0 R >>`);
  objects[root - 1] = Buffer.from(`<< /Type /Pages /Count ${count} /Kids [${pages.map((id) => `${id} 0 R`).join(" ")}] >>`);
  const chunks = [Buffer.from("%PDF-1.4\n")];
  const offsets = [0];
  let size = chunks[0].length;
  objects.forEach((body, index) => {
    offsets.push(size);
    const chunk = Buffer.concat([Buffer.from(`${index + 1} 0 obj\n`), body, Buffer.from("\nendobj\n")]);
    chunks.push(chunk); size += chunk.length;
  });
  chunks.push(Buffer.from(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map((n) => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${size}\n%%EOF\n`));
  const path = join(output, name);
  writeFileSync(path, Buffer.concat(chunks));
  console.log(path);
}

createPdf("two-column.pdf", 4);
createPdf("scanned.pdf", 3, new Set([1, 2, 3]));
createPdf("mixed.pdf", 4, new Set([2, 4]));
createPdf("long-72-pages.pdf", 72, new Set([32, 64]));
