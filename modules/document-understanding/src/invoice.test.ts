import { describe, expect, it } from "vitest";
import { findInvoiceTextValue, normalizedInvoiceText, validateInvoiceAmounts } from "./invoice.js";
import type { PdfTextItem } from "./contracts.js";

const items: readonly PdfTextItem[] = [
  { page: 1, text: "12345678", x: 90, y: 700, width: 50, height: 10 },
  { page: 1, text: "发票号码：", x: 10, y: 700, width: 60, height: 10 },
  { page: 1, text: "价税合计（小写）：¥107.00", x: 10, y: 500, width: 160, height: 10 },
];

describe("invoice deterministic helpers", () => {
  it("orders text geometrically and retains source position", () => {
    expect(normalizedInvoiceText(items)).toBe("发票号码： 12345678\n价税合计（小写）：¥107.00");
    const number = findInvoiceTextValue(items, /发票号码[：:]\s*(?<value>\d{8})/);
    expect(number?.value).toBe("12345678");
    expect(number?.page).toBe(1);
    expect(number?.position.width).toBe(130);
  });

  it("validates net plus tax using integer cents", () => {
    expect(validateInvoiceAmounts(10_000, 700, 10_700)).toEqual({
      valid: true,
      expectedTotalCents: 10_700,
      actualTotalCents: 10_700,
      differenceCents: 0,
    });
    expect(validateInvoiceAmounts(10_000, 700, 10_699)).toMatchObject({ valid: false, differenceCents: -1 });
  });

  it("selects buyer and seller values by occurrence when both columns share a text line", () => {
    const columns: readonly PdfTextItem[] = [
      { page: 1, text: "购 名称：购买方公司", x: 10, y: 600, width: 120, height: 10 },
      { page: 1, text: "销 名称：销售方公司", x: 300, y: 600, width: 120, height: 10 },
      { page: 1, text: "统一社会信用代码/纳税人识别号：BUYER1234567890", x: 10, y: 580, width: 220, height: 10 },
      { page: 1, text: "统一社会信用代码/纳税人识别号：SELLER123456789", x: 300, y: 580, width: 220, height: 10 },
    ];
    const namePattern = /名\s*称\s*[:：]?\s*(?<value>.+?)(?=\s+(?:销\s*)?名\s*称|$)/u;
    const taxPattern = /(?:统一社会信用代码\s*\/\s*)?纳税人识别号\s*[:：]?\s*(?<value>[0-9A-Z]{15,20})/u;
    expect(findInvoiceTextValue(columns, namePattern, 0)?.value).toBe("购买方公司");
    expect(findInvoiceTextValue(columns, namePattern, 1)?.value).toBe("销售方公司");
    expect(findInvoiceTextValue(columns, taxPattern, 0)?.value).toBe("BUYER1234567890");
    expect(findInvoiceTextValue(columns, taxPattern, 1)?.value).toBe("SELLER123456789");
  });
});
