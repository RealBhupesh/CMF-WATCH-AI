import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN = 54;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const BOTTOM = 54;

export async function renderTextResumePdf(text: string): Promise<Buffer> {
  const normalized = sanitizeText(text);
  if (normalized.trim() === "") {
    throw new Error("Resume text is empty");
  }

  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  pdf.setTitle("Resume");
  pdf.setCreator("job-crawler-mcp-server");

  let page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  let y = PAGE_HEIGHT - MARGIN;
  let firstContentLine = true;

  const newPage = (): void => {
    page = pdf.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    y = PAGE_HEIGHT - MARGIN;
  };

  const ensureSpace = (height: number): void => {
    if (y - height < BOTTOM) {
      newPage();
    }
  };

  const drawLine = (
    target: PDFPage,
    line: string,
    options: {
      font: PDFFont;
      size: number;
      indent?: number;
      color?: ReturnType<typeof rgb>;
    },
  ): void => {
    target.drawText(line, {
      x: MARGIN + (options.indent ?? 0),
      y,
      size: options.size,
      font: options.font,
      color: options.color ?? rgb(0.08, 0.08, 0.08),
    });
  };

  for (const rawLine of normalized.split("\n")) {
    const line = rawLine.trimEnd();
    if (line.trim() === "") {
      y -= 7;
      continue;
    }

    const isFirst = firstContentLine;
    firstContentLine = false;
    const isHeading = !isFirst && isSectionHeading(line);
    const isBullet = /^[-*]\s+/.test(line.trim());
    const isContact = /@|https?:\/\/|linkedin\.com|\+?\d[\d\s().-]{6,}/i.test(line);
    const size = isFirst ? 20 : isHeading ? 11.5 : isContact ? 9.5 : 10.5;
    const font = isFirst || isHeading ? bold : regular;
    const indent = isBullet ? 14 : 0;
    const bulletText = isBullet ? line.trim().replace(/^[-*]\s+/, "- ") : line;
    const width = CONTENT_WIDTH - indent;
    const wrapped = wrapText(bulletText, font, size, width);

    if (isHeading) {
      y -= 8;
    }

    for (const wrappedLine of wrapped) {
      ensureSpace(size + 5);
      drawLine(page, wrappedLine, { font, size, indent });
      y -= size + 4;
    }

    if (isFirst || isHeading) {
      y -= 4;
    }
  }

  return Buffer.from(await pdf.save());
}

function sanitizeText(input: string): string {
  const normalized = input
    .replace(/\r\n?/g, "\n")
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\u2022/g, "-")
    .replace(/\u00A0/g, " ")
    .replace(/\t/g, "    ");

  return Array.from(normalized)
    .filter((character) => {
      if (character === "\n") {
        return true;
      }
      const code = character.codePointAt(0) ?? 0;
      return (code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff);
    })
    .join("");
}

function isSectionHeading(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length < 3 || trimmed.length > 64) {
    return false;
  }
  if (!/[A-Z]/.test(trimmed)) {
    return false;
  }
  if (/^[A-Z][A-Z0-9 &/+.-]+$/.test(trimmed)) {
    return true;
  }
  return /^(summary|experience|education|skills|projects|certifications|awards|publications|volunteer|leadership|work history|professional experience)\s*:?$/i.test(
    trimmed,
  );
}

function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return [""];
  }

  const lines: string[] = [];
  let current = "";

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
      current = candidate;
      continue;
    }

    if (current) {
      lines.push(current);
      current = "";
    }

    if (font.widthOfTextAtSize(word, size) <= maxWidth) {
      current = word;
      continue;
    }

    for (const piece of breakLongWord(word, font, size, maxWidth)) {
      lines.push(piece);
    }
  }

  if (current) {
    lines.push(current);
  }

  return lines.length > 0 ? lines : [""];
}

function breakLongWord(word: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const pieces: string[] = [];
  let current = "";

  for (const character of word) {
    const candidate = `${current}${character}`;
    if (current && font.widthOfTextAtSize(candidate, size) > maxWidth) {
      pieces.push(current);
      current = character;
    } else {
      current = candidate;
    }
  }

  if (current) {
    pieces.push(current);
  }

  return pieces;
}
