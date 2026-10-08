import { expect, it } from "vitest";
import { fileMentionQuery } from "../src/components/file-mention-query.ts";

it("opens file mentions after Chinese text and punctuation, preserving the preceding text", () => {
  for (const prefix of ["", " ", "\n", "帮我看看", "参考：", "参考，", "（", "。", "𠮷"]) {
    for (const query of ["", "src/文件"]) {
      expect(fileMentionQuery(`${prefix}@${query}`)).toEqual({
        start: prefix.length,
        end: prefix.length + query.length + 1,
        query,
      });
    }
  }
});

it("rejects email forms while allowing dotted file names after explicit mention boundaries", () => {
  for (const text of ["name@", "name@example.com", "123@foo", "用户@例子.公司", "联系邮箱@example.com"]) {
    expect(fileMentionQuery(text)).toBeUndefined();
  }
  for (const prefix of ["", " ", "参考：", "看看，"]) {
    expect(fileMentionQuery(`${prefix}@foo.ts`)?.query).toBe("foo.ts");
  }
});

it("ends the file query at whitespace or another input trigger", () => {
  for (const text of [
    "看看@foo ",
    "@foo\n",
    "看看@foo$bar",
    "看看@foo#bar",
    "看看@foo¥bar",
    "看看@foo@bar",
  ]) {
    expect(fileMentionQuery(text)).toBeUndefined();
  }
});
