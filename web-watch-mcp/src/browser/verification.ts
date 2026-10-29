import type { Page } from "playwright";

export interface VerificationResult {
  detected: boolean;
  providers: string[];
  signals: string[];
  url: string;
  title: string;
  policy: "human";
  message: string;
}

const PROVIDER_SELECTORS: Array<{ provider: string; selectors: string[] }> = [
  {
    provider: "recaptcha",
    selectors: [
      'iframe[src*="recaptcha"]',
      ".g-recaptcha",
      'textarea[name="g-recaptcha-response"]',
      'script[src*="recaptcha"]',
    ],
  },
  {
    provider: "hcaptcha",
    selectors: ['iframe[src*="hcaptcha"]', ".h-captcha", 'textarea[name="h-captcha-response"]'],
  },
  {
    provider: "cloudflare-turnstile",
    selectors: [
      'iframe[src*="challenges.cloudflare.com"]',
      ".cf-turnstile",
      'input[name="cf-turnstile-response"]',
    ],
  },
  {
    provider: "cloudflare-challenge",
    selectors: [
      "#challenge-form",
      "#cf-challenge-running",
      ".cf-challenge",
      "#cf-please-wait",
      'iframe[src*="/cdn-cgi/challenge-platform/"]',
    ],
  },
  {
    provider: "arkose",
    selectors: ['iframe[src*="arkoselabs"]', 'iframe[src*="funcaptcha"]', "#arkose"],
  },
  {
    provider: "perimeterx",
    selectors: ['#px-captcha', '[id*="px-captcha"]', '[class*="px-captcha"]'],
  },
  {
    provider: "aws-waf",
    selectors: [
      "#aws-captcha-container",
      "[data-aws-captcha]",
      'iframe[src*="captcha.awswaf.com"]',
    ],
  },
  {
    provider: "datadome",
    selectors: ['iframe[src*="geo.captcha-delivery.com"]', "#datadome-captcha"],
  },
];

const TEXT_SIGNALS = [
  "verify you are human",
  "verify you are a human",
  "please verify you are a human",
  "are you a robot",
  "i'm not a robot",
  "i am not a robot",
  "complete the captcha",
  "complete the security check",
  "human verification",
  "security verification",
  "checking your browser",
  "checking if the site connection is secure",
  "verifying your browser",
  "press and hold",
  "unusual traffic",
  "unusual activity",
  "automated access",
  "one more step",
  "enable javascript and cookies to continue",
  "sorry, you have been blocked",
  "your request has been blocked",
  "you have been blocked",
  "request unsuccessful",
];

const TITLE_SIGNALS = [
  "just a moment",
  "attention required",
  "security check",
  "access denied",
  "are you a robot",
];

export async function detectHumanVerification(page: Page): Promise<VerificationResult> {
  const url = page.url();
  let title = "";
  try {
    title = await page.title();
  } catch {
    title = "";
  }

  const providers = new Set<string>();
  const signals = new Set<string>();

  for (const frame of page.frames()) {
    let frameSignals: { providers: string[]; text: string } | undefined;

    try {
      frameSignals = await frame.evaluate(
        ({ selectors, textSignals }) => {
          const visible = (element: Element): boolean => {
            const style = window.getComputedStyle(element);
            if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
              return false;
            }

            const rect = element.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) {
              return false;
            }

            if (typeof element.checkVisibility === "function") {
              try {
                return element.checkVisibility({
                  checkOpacity: true,
                  checkVisibilityCSS: true,
                });
              } catch {
                return true;
              }
            }

            return true;
          };

          const foundProviders: string[] = [];

          for (const group of selectors) {
            for (const selector of group.selectors) {
              let element: Element | null = null;
              try {
                element = document.querySelector(selector);
              } catch {
                continue;
              }
              if (element && visible(element)) {
                foundProviders.push(group.provider);
                break;
              }
            }
          }

          const bodyText = (document.body?.innerText ?? "").toLowerCase().slice(0, 50_000);
          const foundText = textSignals.filter((signal) => bodyText.includes(signal));

          return { providers: foundProviders, text: foundText.join("\n") };
        },
        { selectors: PROVIDER_SELECTORS, textSignals: TEXT_SIGNALS },
      );
    } catch {
      continue;
    }

    for (const provider of frameSignals.providers) {
      providers.add(provider);
    }
    for (const signal of frameSignals.text.split("\n").filter(Boolean)) {
      signals.add(signal);
    }
  }

  const lowerUrl = url.toLowerCase();
  if (lowerUrl.includes("/cdn-cgi/challenge-platform/")) {
    providers.add("cloudflare-challenge");
  }
  if (lowerUrl.includes("captcha")) {
    signals.add("captcha in URL");
  }

  const lowerTitle = title.toLowerCase();
  for (const signal of TITLE_SIGNALS) {
    if (lowerTitle.includes(signal)) {
      signals.add(`page title: ${signal}`);
    }
  }

  const detected = providers.size > 0 || signals.size > 0;
  const providerList = [...providers];
  const signalList = [...signals].slice(0, 8);

  return {
    detected,
    providers: providerList,
    signals: signalList,
    url,
    title,
    policy: "human",
    message: detected
      ? buildMessage(providerList, signalList)
      : "No human-verification challenge detected.",
  };
}

export class HumanVerificationRequiredError extends Error {
  constructor(readonly result: VerificationResult) {
    super(result.message);
    this.name = "HumanVerificationRequiredError";
  }
}

export async function requireNoHumanVerification(page: Page): Promise<void> {
  const result = await detectHumanVerification(page);
  if (result.detected) {
    throw new HumanVerificationRequiredError(result);
  }
}

function buildMessage(providers: string[], signals: string[]): string {
  const details = [
    providers.length > 0 ? `providers: ${providers.join(", ")}` : undefined,
    signals.length > 0 ? `signals: ${signals.join(", ")}` : undefined,
  ]
    .filter(Boolean)
    .join("; ");

  return [
    "Human verification or a bot wall was detected.",
    details,
    "This server will not solve or bypass it.",
    "Ask the user to complete the challenge in the visible browser window, then call browser_human_verification with action=wait or action=check.",
  ].join(" ");
}

