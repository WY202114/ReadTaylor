// 生成测试用 EPUB（带插图、目录）和 3 页 PDF，供本地预览验证原样排版。
// 用法: node test-assets/gen.mjs
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// ---------- 最小 ZIP 写入器（stored，无压缩） ----------
function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = crc32.table = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[i] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function makeZip(entries) {
  // entries: [{ name, data: Buffer }]
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method: stored
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0x21, 12); // date
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, nameBuf);

    offset += 30 + nameBuf.length + data.length;
  }
  const centralStart = offset;
  const centralBuf = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(centralStart, 16);
  return Buffer.concat([...localParts, centralBuf, eocd]);
}

// ---------- EPUB ----------
// 8x8 红色 PNG
const PNG_RED = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFUlEQVR4nGP8z8DwnwEPYMKnYBgoAACR9QEHO1d6/AAAAABJRU5ErkJggg==",
  "base64"
);

const xhtml = (title, body) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>${title}</title></head>
<body>${body}</body>
</html>`;

const ch1 = xhtml("第一章", `
<h1>第一章 原样排版测试</h1>
<p style="color:#2f6b5e;font-weight:bold;">这一段带原书样式（绿色加粗）。</p>
<blockquote>这是一个引用块，文本模式下会被拍平。</blockquote>
<p>书内目录链接：<a id="link-to-ch2" href="ch2.xhtml">跳到第二章</a></p>
<p>外部链接：<a id="link-external" href="https://example.com/">example.com</a></p>
<p>下面是一张插图：</p>
<img src="img.png" alt="红色方块" style="width:120px;height:120px;"/>
<p>插图之后的段落。FIDELITY_MARKER_CH1</p>
${Array.from({ length: 30 }, (_, i) => `<p>第一章填充段落 ${i + 1}，用来撑出滚动高度。</p>`).join("\n")}
`);

const ch2 = xhtml("第二章", `
<h1>第二章 翻页与目录测试</h1>
<p>FIDELITY_MARKER_CH2</p>
${Array.from({ length: 40 }, (_, i) => `<p>第二章填充段落 ${i + 1}。</p>`).join("\n")}
`);

const nav = xhtml("目录", `
<nav epub:type="toc"><h1>目录</h1><ol>
<li><a href="ch1.xhtml">第一章 原样排版测试</a></li>
<li><a href="ch2.xhtml">第二章 翻页与目录测试</a></li>
</ol></nav>`);

const opf = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">rt-test-epub-001</dc:identifier>
    <dc:title>ReadTaylor 原样排版测试书</dc:title>
    <dc:language>zh-CN</dc:language>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
    <item id="img" href="img.png" media-type="image/png"/>
  </manifest>
  <spine>
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
  </spine>
</package>`;

const container = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

const epub = makeZip([
  { name: "mimetype", data: Buffer.from("application/epub+zip") },
  { name: "META-INF/container.xml", data: Buffer.from(container) },
  { name: "OEBPS/content.opf", data: Buffer.from(opf) },
  { name: "OEBPS/nav.xhtml", data: Buffer.from(nav) },
  { name: "OEBPS/ch1.xhtml", data: Buffer.from(ch1) },
  { name: "OEBPS/ch2.xhtml", data: Buffer.from(ch2) },
  { name: "OEBPS/img.png", data: PNG_RED },
]);
writeFileSync(join(here, "test.epub"), epub);

// ---------- PDF：3 页，每页一行文字，offsets 程序计算 ----------
function makePdf() {
  const objects = [];
  const pageTexts = ["PDF PAGE ONE", "PDF PAGE TWO", "PDF PAGE THREE"];
  // 1: catalog, 2: pages, 3..5: page, 6..8: content, 9: font
  objects[1] = `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`;
  objects[2] = `2 0 obj\n<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >>\nendobj\n`;
  pageTexts.forEach((text, i) => {
    const pageNum = 3 + i;
    const contentNum = 6 + i;
    objects[pageNum] = `${pageNum} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 600] /Contents ${contentNum} 0 R /Resources << /Font << /F1 9 0 R >> >> >>\nendobj\n`;
    const stream = `BT /F1 24 Tf 60 500 Td (${text}) Tj ET`;
    objects[contentNum] = `${contentNum} 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`;
  });
  objects[9] = `9 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n`;

  let pdf = "%PDF-1.4\n";
  const offsets = [];
  for (let i = 1; i <= 9; i++) {
    offsets[i] = Buffer.byteLength(pdf);
    pdf += objects[i];
  }
  const xrefStart = Buffer.byteLength(pdf);
  pdf += "xref\n0 10\n0000000000 65535 f \n";
  for (let i = 1; i <= 9; i++) {
    pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size 10 /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}
writeFileSync(join(here, "test.pdf"), makePdf());

console.log("生成完成: test.epub, test.pdf");
