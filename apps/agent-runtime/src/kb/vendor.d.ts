// mammoth / pdfjs-dist 的 legacy ESM 子路径不保证类型可达，这里补最小环境声明。
declare module 'mammoth' {
  export function extractRawText(input: { buffer: Buffer }): Promise<{ value: string }>;
}

declare module 'pdfjs-dist/legacy/build/pdf.mjs' {
  interface PdfTextItem {
    str?: string;
  }
  interface PdfPage {
    getTextContent(): Promise<{ items: PdfTextItem[] }>;
  }
  interface PdfDoc {
    numPages: number;
    getPage(n: number): Promise<PdfPage>;
  }
  export function getDocument(src: { data: Uint8Array; isEvalSupported?: boolean }): {
    promise: Promise<PdfDoc>;
  };
}
