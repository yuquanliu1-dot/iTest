export interface VisionPlan {
  useVision: boolean;
  sourceSelector?: string;
  outputSelector?: string;
  cleanedInstruction: string;
}

export class InvalidVisionSelectorError extends Error {
  constructor(public readonly selector: string) {
    super(`InvalidVisionSelector: ${selector.slice(0, 50)}`);
    this.name = 'InvalidVisionSelectorError';
  }
}

export class TooManyVisionSelectorsError extends Error {
  constructor(public readonly count: number) {
    super(`TooManyVisionSelectorsError: too many placeholders (${count})`);
    this.name = 'TooManyVisionSelectorsError';
  }
}

const ALLOWED = /^[a-zA-Z0-9_.\-#>+~*:[\]"=\s]+$/;

/** 从 instruction 解析 #cssSelector 占位符；非法字符抛 InvalidVisionSelectorError；>2 占位符抛 TooManyVisionSelectorsError。 */
export function planVision(raw: string): VisionPlan {
  const re = /#([a-zA-Z_][^\s"#]*)/g;
  const matches: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    matches.push(m[0]);
  }
  if (matches.length === 0) {
    return { useVision: false, cleanedInstruction: raw };
  }
  if (matches.length > 2) throw new TooManyVisionSelectorsError(matches.length);
  for (const sel of matches) {
    if (!ALLOWED.test(sel)) throw new InvalidVisionSelectorError(sel);
  }
  return {
    useVision: true,
    sourceSelector: matches[0],
    outputSelector: matches[1],
    cleanedInstruction: raw.replace(re, '').trim(),
  };
}
