import type { Frame, Locator, Page } from "playwright";
import { randomUUID } from "node:crypto";
import { isSensitiveField } from "../security/fields.js";
import { detectHumanVerification, type VerificationResult } from "./verification.js";

const INTERACTIVE_SELECTOR = [
  "a[href]",
  "button",
  "input:not([type=hidden])",
  "select",
  "textarea",
  "summary",
  "[contenteditable=true]",
  "[role=button]",
  "[role=link]",
  "[role=checkbox]",
  "[role=radio]",
  "[role=switch]",
  "[role=tab]",
  "[role=combobox]",
  "[role=textbox]",
  "[role=searchbox]",
  "[role=menuitem]",
  "[role=option]",
  "[onclick]",
].join(",");

const snapshots = new WeakMap<Page, Map<string, { frame: Frame; url: string }>>();

export class StaleRefError extends Error {
  constructor(ref: string) {
    super(`Element ref ${ref} is stale or unknown. Call browser_snapshot and use a fresh ref.`);
    this.name = "StaleRefError";
  }
}

export interface SnapshotElement {
  ref: string;
  frame: string;
  tag: string;
  role: string;
  name: string;
  fieldName?: string;
  type?: string;
  value?: string;
  placeholder?: string;
  autocomplete?: string;
  href?: string;
  checked?: boolean;
  disabled?: boolean;
  required?: boolean;
  readOnly?: boolean;
  maxLength?: number;
  options?: Array<{ label: string; value: string }>;
}

export interface FrameInfo {
  id: string;
  name: string;
  url: string;
}

export interface PageSnapshot {
  sessionId?: string;
  tabId?: string;
  url: string;
  title: string;
  capturedAt: string;
  frameCount: number;
  frames: FrameInfo[];
  elements: SnapshotElement[];
  elementCount: number;
  truncatedElements: boolean;
  text: string;
  textTruncated: boolean;
  verification: VerificationResult;
}

export interface SnapshotOptions {
  includeText?: boolean;
  maxTextChars?: number;
  maxElements?: number;
}

export async function captureSnapshot(
  page: Page,
  options: SnapshotOptions = {},
): Promise<PageSnapshot> {
  const includeText = options.includeText ?? true;
  const maxTextChars = options.maxTextChars ?? 20_000;
  const maxElements = options.maxElements ?? 200;

  const frames = page.frames();
  const frameInfo: FrameInfo[] = frames.map((frame, index) => ({
    id: `f${index}`,
    name: frame.name(),
    url: frame.url(),
  }));

  const elements: SnapshotElement[] = [];
  const generation = randomUUID().replaceAll("-", "");
  const refs = new Map<string, { frame: Frame; url: string }>();
  snapshots.set(page, refs);
  let truncatedElements = false;
  let text = "";

  for (const [index, frame] of frames.entries()) {
    const remaining = maxElements - elements.length;
    if (remaining <= 0) {
      truncatedElements = true;
      break;
    }

    try {
      const result = await frame.evaluate(
        ({ selector, frameIndex, maxElements: frameLimit, generation, includeText, maxTextChars }) => {
          const normalize = (value: string | null | undefined): string =>
            (value ?? "").replace(/\s+/g, " ").trim();

          const visible = (element: Element): boolean => {
            if (element.getAttribute("aria-hidden") === "true") {
              return false;
            }
            if (element.closest('[aria-hidden="true"]')) {
              return false;
            }

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

          const roleFor = (element: Element): string => {
            const explicit = element.getAttribute("role");
            if (explicit) {
              return explicit;
            }

            const tag = element.tagName.toLowerCase();
            if (tag === "a") return "link";
            if (tag === "button" || tag === "summary") return "button";
            if (tag === "textarea") return "textbox";
            if (tag === "select") return "combobox";
            if (element.getAttribute("contenteditable") === "true") return "textbox";

            if (tag === "input") {
              const type = (element as HTMLInputElement).type;
              switch (type) {
                case "checkbox":
                  return "checkbox";
                case "radio":
                  return "radio";
                case "range":
                  return "slider";
                case "file":
                  return "file";
                case "submit":
                case "button":
                case "reset":
                case "image":
                  return "button";
                case "search":
                  return "searchbox";
                case "number":
                  return "spinbutton";
                case "date":
                case "datetime-local":
                case "month":
                case "time":
                case "week":
                  return "date";
                default:
                  return "textbox";
              }
            }

            return tag;
          };

          const nameFor = (element: Element): string => {
            const labelledBy = element.getAttribute("aria-labelledby");
            if (labelledBy) {
              const parts = labelledBy
                .split(/\s+/)
                .map((id) => document.getElementById(id)?.textContent ?? "")
                .map(normalize)
                .filter(Boolean);
              if (parts.length > 0) {
                return parts.join(" ").slice(0, 240);
              }
            }

            const ariaLabel = normalize(element.getAttribute("aria-label"));
            if (ariaLabel) {
              return ariaLabel.slice(0, 240);
            }

            const labels = "labels" in element ? (element as HTMLInputElement).labels : null;
            if (labels && labels.length > 0) {
              const labelText = Array.from(labels)
                .map((label) => normalize(label.textContent))
                .filter(Boolean)
                .join(" ");
              if (labelText) {
                return labelText.slice(0, 240);
              }
            }

            const placeholder = normalize((element as HTMLInputElement).placeholder);
            if (placeholder) {
              return placeholder.slice(0, 240);
            }

            const alt = normalize(element.getAttribute("alt"));
            if (alt) {
              return alt.slice(0, 240);
            }

            const title = normalize(element.getAttribute("title"));
            if (title) {
              return title.slice(0, 240);
            }

            const textContent = normalize(element.textContent);
            if (textContent) {
              return textContent.slice(0, 240);
            }

            return normalize(element.getAttribute("name")).slice(0, 240);
          };

          const seen = new Set<Element>();
          const candidates: Element[] = [];
          let visited = 0;

          const collect = (root: Document | ShadowRoot, depth: number): void => {
            if (depth > 3 || visited > 8000) {
              return;
            }

            for (const element of Array.from(root.querySelectorAll(selector))) {
              if (!seen.has(element)) {
                seen.add(element);
                candidates.push(element);
              }
            }

            for (const element of Array.from(root.querySelectorAll("*"))) {
              visited += 1;
              if (visited > 8000) {
                break;
              }
              if (element.shadowRoot) {
                collect(element.shadowRoot, depth + 1);
              }
            }
          };

          collect(document, 0);

          seen.forEach((element) => {
            element.removeAttribute("data-mcp-ref");
          });

          const output: Array<Record<string, unknown>> = [];
          let counter = 0;
          let totalVisible = 0;

          for (const element of candidates) {
            if (!visible(element)) {
              continue;
            }
            totalVisible += 1;
            if (output.length >= frameLimit) continue;

            counter += 1;
            const localRef = `e${generation}-${counter}`;
            const ref = `f${frameIndex}:${localRef}`;
            element.setAttribute("data-mcp-ref", localRef);

            const tag = element.tagName.toLowerCase();
            const type =
              tag === "input" ? (element as HTMLInputElement).type : undefined;
            const valueElement = element as HTMLInputElement;
            const isPassword = type === "password";
            const isFile = type === "file";

            let value: string | undefined;
            if (isPassword) {
              value = "***";
            } else if (isFile) {
              const files = valueElement.files;
              value = files && files.length > 0
                ? Array.from(files).map((file) => file.name).join(", ")
                : "";
            } else if (tag === "select") {
              const select = element as HTMLSelectElement;
              value = Array.from(select.selectedOptions)
                .map((option) => option.value)
                .join(", ");
            } else if ("value" in element) {
              value = String(valueElement.value ?? "").slice(0, 400);
            }

            const options =
              tag === "select"
                ? Array.from((element as HTMLSelectElement).options)
                    .slice(0, 80)
                    .map((option) => ({
                      label: normalize(option.label || option.textContent).slice(0, 160),
                      value: option.value.slice(0, 160),
                    }))
                : undefined;

            output.push({
              ref,
              frame: `f${frameIndex}`,
              tag,
              role: roleFor(element),
              name: nameFor(element),
              fieldName:
                normalize(element.getAttribute("name") || element.id).slice(0, 160) || undefined,
              type,
              value,
              placeholder:
                normalize((element as HTMLInputElement).placeholder).slice(0, 160) || undefined,
              autocomplete:
                normalize(element.getAttribute("autocomplete")).slice(0, 160) || undefined,
              href:
                tag === "a"
                  ? (element as HTMLAnchorElement).href.slice(0, 600)
                  : undefined,
              checked:
                "checked" in element ? Boolean(valueElement.checked) : undefined,
              disabled:
                "disabled" in element ? Boolean(valueElement.disabled) : undefined,
              required:
                "required" in element ? Boolean(valueElement.required) : undefined,
              readOnly:
                "readOnly" in element ? Boolean(valueElement.readOnly) : undefined,
              maxLength:
                typeof valueElement.maxLength === "number" && valueElement.maxLength > 0
                  ? valueElement.maxLength
                  : undefined,
              options,
            });
          }

          return {
            elements: output,
            total: totalVisible,
            text: includeText ? (document.body?.innerText ?? "").slice(0, maxTextChars + 1) : "",
          };
        },
        { selector: INTERACTIVE_SELECTOR, frameIndex: index, maxElements: remaining, generation, includeText, maxTextChars },
      );

      for (const raw of result.elements) {
        if (isSensitiveField([raw.type, raw.name, raw.fieldName, raw.autocomplete, raw.placeholder].filter(Boolean).join(" "))) raw.value = "***";
        elements.push(raw as unknown as SnapshotElement);
        refs.set(String(raw.ref), { frame, url: frame.url() });
      }

      if (result.total > result.elements.length) {
        truncatedElements = true;
      }

      if (index === 0) {
        text = result.text;
      }
    } catch (error) {
      if (frame === page.mainFrame()) {
        throw error;
      }
      continue;
    }
  }

  const verification = await detectHumanVerification(page);
  const title = await page.title().catch(() => "");
  const textTruncated = text.length > maxTextChars;

  return {
    url: page.url(),
    title,
    capturedAt: new Date().toISOString(),
    frameCount: frames.length,
    frames: frameInfo,
    elements,
    elementCount: elements.length,
    truncatedElements,
    text: includeText ? text.slice(0, maxTextChars) : "",
    textTruncated,
    verification,
  };
}

export interface Target {
  ref?: string;
  selector?: string;
  text?: string;
  frame?: string;
}

export function parseRef(ref: string): { frameIndex: number; localRef: string } {
  const match = ref.match(/^f(\d+):(.+)$/);
  if (match) {
    return { frameIndex: Number.parseInt(match[1], 10), localRef: match[2] };
  }

  return { frameIndex: 0, localRef: ref };
}

export function resolveFrame(page: Page, frame?: string): Frame {
  if (!frame) {
    return page.mainFrame();
  }

  const frames = page.frames();
  const indexMatch = frame.match(/^f(\d+)$/);
  if (indexMatch) {
    const index = Number.parseInt(indexMatch[1], 10);
    const selected = frames[index];
    if (selected) {
      return selected;
    }
  }

  const selected = frames.find(
    (candidate) => candidate.name() === frame || candidate.url().includes(frame),
  );
  if (!selected) {
    throw new Error(`Frame not found: ${frame}. Call browser_snapshot to list frames.`);
  }

  return selected;
}

export function resolveLocator(page: Page, target: Target): Locator {
  if (target.ref) {
    const parsed = parseRef(target.ref);
    const entry = snapshots.get(page)?.get(target.ref);
    if (!entry || entry.frame.isDetached() || entry.frame.url() !== entry.url) throw new StaleRefError(target.ref);
    const frame = entry.frame;

    const locator = frame.locator(`[data-mcp-ref="${cssEscape(parsed.localRef)}"]`);
    return locator;
  }

  const frame = resolveFrame(page, target.frame);
  if (target.selector) {
    return frame.locator(target.selector);
  }

  if (target.text) {
    return frame.getByText(target.text, { exact: false }).first();
  }

  throw new Error("Provide ref, selector, or text to identify an element");
}

function cssEscape(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
