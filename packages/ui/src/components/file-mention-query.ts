// Match ZCode's Chinese mention boundaries without changing command or skill triggers.
const mentionPattern = /(^|[\s\p{Script=Han}\u3000-\u303f\uff00-\uffef])@([^\s@$#¥￥]*)$/u;

export function fileMentionQuery(prefix: string) {
  const match = mentionPattern.exec(prefix);
  if (!match || (/\p{Script=Han}/u.test(match[1]) && /\S\.\S/.test(match[2]))) return undefined;
  return { start: prefix.length - match[2].length - 1, end: prefix.length, query: match[2] };
}
