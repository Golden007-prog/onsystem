import { wcagContrast } from 'culori';
import ts from 'typescript';

import { propertyName } from '../../extract/cva.js';
import {
  colorDistance,
  findColorLiterals,
  formatDistance,
  formatOpacityGap,
  isNamedColor,
  isTinted,
  parseColor,
  SAME_COLOR,
  type Oklch,
} from '../../tokens/color.js';
import type { ColorCandidate, ColorSuggestion, Nearest } from '../../tokens/index.js';
import {
  colorRole,
  scopesIn,
  tokenRole,
  type ColorRole,
  type ScopedFamily,
} from '../../tokens/roles.js';
import { formatPx, lengthToPx } from '../../tokens/units.js';
import { cssReference } from '../../tokens/usage.js';
import type { Token } from '../../types.js';
import { truncate } from '../../util/strings.js';
import { attributeName, literalValues, valueBranches, type JsxNode } from '../analyze.js';
import type { Report, Rule, RuleContext } from '../context.js';
import { TAILWIND_KEYWORD_COLORS, TAILWIND_PALETTE } from '../tailwind-palette.js';
import {
  COLOR_PREFIXES,
  COLOR_UTILITY,
  NEGATIVE_PREFIXES,
  RADIUS_PREFIXES,
  SPACING_PREFIXES,
  STYLE_COLOR_PROPERTIES,
  STYLE_RADIUS_PROPERTIES,
  STYLE_SPACING_PROPERTIES,
  cssColorProperty,
  isColorAttribute,
  paletteColor,
  parseUtility,
  splitClasses,
  withBase,
  type Utility,
} from '../tailwind.js';

// ─── Colors ─────────────────────────────────────────────────────────────────

/** `var(--color-green-50)`: a shade of Tailwind's palette through its CSS variable. */
const PALETTE_VARIABLE = /^var\(\s*--color-([a-z]+-(?:50|[1-9]00|950))\s*\)$/;

/** Luminance values, not design colors: `white`/`black` (and hex twins). */
const MASK_LUMINANCE = new Set(['white', 'black', '#fff', '#ffffff', '#000', '#000000']);

/**
 * Whether the element sits inside an SVG `<mask>`: a stop's luminance sets
 * opacity there, so `white`/`black` stops are not design-system colors (#59).
 */
function isInsideMask(element: JsxNode): boolean {
  const sourceFile = element.node.getSourceFile();
  const mask = ts.findAncestor(element.node, (node) => {
    if (!ts.isJsxElement(node) && !ts.isJsxSelfClosingElement(node)) {
      return false;
    }
    const opening = ts.isJsxElement(node) ? node.openingElement : node;
    return opening.tagName.getText(sourceFile) === 'mask';
  });
  return mask !== undefined;
}

/** `id` of the wrapping gradient, if the stop sits directly in one. */
function gradientIdOfStop(element: JsxNode): string | undefined {
  const gradient = ts.findAncestor(
    element.node.parent,
    (node) => ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node),
  );
  if (gradient === undefined) return undefined;
  const opening = ts.isJsxElement(gradient) ? gradient.openingElement : gradient;
  const tag = opening.tagName.getText(element.node.getSourceFile());
  if (tag !== 'linearGradient' && tag !== 'radialGradient') {
    return undefined;
  }
  const idAttr = opening.attributes.properties
    .filter(ts.isJsxAttribute)
    .find((a) => attributeName(a) === 'id');
  return idAttr?.initializer && ts.isStringLiteralLike(idAttr.initializer)
    ? idAttr.initializer.text
    : undefined;
}

const URL_REF = /url\(\s*#([^)\s]+)\s*\)/g;

/**
 * Gradient ids referenced via `fill="url(#id)"` (or `stroke`) from inside a
 * `<mask>` subtree: stops of those gradients paint mask luminance, not
 * colors (#59, cal.com gridFade/gridMask shape).
 */
function maskReferencedGradientIds(elements: JsxNode[]): Set<string> {
  const ids = new Set<string>();
  const refsFrom = (node: ts.Node): void => {
    if (ts.isJsxAttribute(node)) {
      const name = attributeName(node);
      if (
        (name === 'fill' || name === 'stroke') &&
        node.initializer &&
        ts.isStringLiteralLike(node.initializer)
      ) {
        URL_REF.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = URL_REF.exec(node.initializer.text)) !== null) {
          if (match[1]) ids.add(match[1]);
        }
      }
    }
    ts.forEachChild(node, refsFrom);
  };
  for (const element of elements) {
    if (element.tag === 'mask') refsFrom(element.node);
  }
  return ids;
}

export const noHardcodedColor: Rule = shortQuotes({
  id: 'no-hardcoded-color',
  description:
    'Colors must come from design tokens: no hex/rgb/oklch literals, arbitrary Tailwind colors or default-palette classes.',
  run(context) {
    const { tokens } = context.target;
    if (!tokens.has('color')) return;
    const allow = new Set((context.options.allow ?? []).map((v) => v.toLowerCase()));
    const maskGradients = maskReferencedGradientIds(context.analysis.elements);
    // An element's classes are one list, across cn() arguments; a string elsewhere is its own.
    const lists = new Map<object, ListedClass[]>();

    for (const classString of context.analysis.classStrings) {
      const key = classString.element ?? classString;
      const list = lists.get(key) ?? [];
      lists.set(key, list);
      const element = classString.element;
      for (const token of splitClasses(classString.text, classString.start)) {
        const utility = parseUtility(token.value);
        const listed: ListedClass = {
          value: token.value,
          prefix: tokenColorPrefix(utility, tokens.colorKeys),
          element,
        };
        list.push(listed);
        // An allowed class is not reported, but its color is kept: text in it stays as it is.
        const allowed = allow.has(token.value.toLowerCase());

        if (
          utility.arbitrary !== undefined &&
          utility.prefix &&
          COLOR_PREFIXES.includes(utility.prefix)
        ) {
          const value = utility.arbitrary.replace(/^color:/, '').trim();
          // `bg-[var(--color-green-50)]` is the palette class `bg-green-50`, written as its variable.
          const shade = PALETTE_VARIABLE.exec(value)?.[1];
          const viaVariable = shade ? paletteColor(`${utility.prefix}-${shade}`) : undefined;
          if (viaVariable) {
            const color = tokens.colorKeys.has(viaVariable.key)
              ? undefined
              : parseColor(viaVariable.value);
            if (!color) continue;
            listed.color = color;
            listed.prefix = viaVariable.prefix;
            listed.tinted = !viaVariable.gray;
            if (allowed) continue;
            listed.report = colorReport(context, {
              start: token.start,
              end: token.end,
              what: `\`${token.value}\` is Tailwind's default palette (\`${viaVariable.key}\`), not a design-system color`,
              color,
              tinted: !viaVariable.gray,
              palette: viaVariable.key,
              prefix: viaVariable.prefix,
              place: 'class',
              utility,
              element,
              classes: classString.text,
            });
            continue;
          }
          const whole = parseColor(value);
          // `shadow-[0_1px_2px_#000]`: report the color inside, but no class can replace it 1:1.
          const literal = whole ? { text: value, color: whole } : findColorLiterals(value)[0];
          if (!literal) continue;
          listed.color = literal.color;
          listed.prefix = whole ? utility.prefix : undefined;
          if (allowed || allow.has(literal.text.toLowerCase())) continue;
          listed.report = colorReport(context, {
            start: token.start,
            end: token.end,
            what: `Hardcoded color \`${token.value}\``,
            color: literal.color,
            prefix: listed.prefix,
            place: 'class',
            utility,
            element,
            classes: classString.text,
          });
          continue;
        }

        const property = utility.property ? cssColorProperty(utility.property) : undefined;
        if (property && utility.arbitrary !== undefined) {
          // `[background-color:#f00]`: the property's own utility replaces the whole class.
          const value = utility.arbitrary.trim();
          const whole = parseColor(value);
          const literal = whole ? { text: value, color: whole } : findColorLiterals(value)[0];
          if (!literal) continue;
          listed.color = literal.color;
          listed.prefix = whole ? property.prefix : undefined;
          if (allowed || allow.has(literal.text.toLowerCase())) continue;
          listed.report = colorReport(context, {
            start: token.start,
            end: token.end,
            what: `Hardcoded color \`${token.value}\``,
            color: literal.color,
            prefix: listed.prefix,
            place: 'class',
            utility,
            element,
            classes: classString.text,
          });
          continue;
        }

        const palette = paletteColor(utility.base);
        if (palette && !tokens.colorKeys.has(palette.key)) {
          const color = parseColor(palette.value);
          if (!color) continue;
          listed.color = color;
          listed.prefix = palette.prefix;
          listed.tinted = !palette.gray;
          if (allowed) continue;
          listed.report = colorReport(context, {
            start: token.start,
            end: token.end,
            what: `\`${token.value}\` is Tailwind's default palette, not a design-system color`,
            color,
            tinted: !palette.gray,
            palette: palette.key,
            prefix: palette.prefix,
            place: 'class',
            utility,
            element,
            classes: classString.text,
          });
          continue;
        }

        // `bg-white`, `text-black`: reported once the whole class list is known, since white
        // text on a colored surface in the same list is that surface's.
        const keyword = keywordColor(utility, tokens.colorKeys);
        // `text-black/80` is not reported, but like any hardcoded text it stays as it is when
        // the background under it is fixed, so its color is kept for that.
        const tint = keyword ? undefined : keywordColor(utility, tokens.colorKeys, true);
        if (tint && colorRole(tint.prefix) === 'text' && !(element && isInsideMask(element))) {
          listed.color = tint.color;
          listed.prefix = tint.prefix;
        }
        if (keyword && !(element && isInsideMask(element))) {
          listed.color = keyword.color;
          listed.prefix = keyword.prefix;
          if (allowed) continue;
          listed.keyword = {
            start: token.start,
            end: token.end,
            what: `\`${token.value}\` is a fixed color, not a design-system color`,
            color: keyword.color,
            tinted: false,
            keyword: true,
            prefix: keyword.prefix,
            place: 'class',
            utility,
            element,
            classes: classString.text,
          };
        }
      }
    }
    const surfaces = new Surfaces(context, lists);
    // Hardcoded text, icon fill or stroke that stays as it is, and the class list of the surface
    // it is on: white or black, a tint of them (`text-black/80`), or a color whose own finding
    // has no fix (`text-neutral-900` held back as another shade, an allowed class).
    const texts: { text: ListedClass; list: readonly ListedClass[] }[] = [];
    // Text with a fix of its own, which a state class can still take back.
    const fixedTexts: typeof texts = [];
    for (const list of lists.values()) {
      for (const listed of list) {
        const text = colorRole(listed.prefix) === 'text' && listed.color !== undefined;
        if (listed.keyword) {
          if (text) {
            // White or black text, icon fill or stroke on a colored surface is that surface's
            // contrast color (shadcn/ui's `bg-destructive text-white`), not a theme color.
            const placed = surfaces.place(list, listed);
            texts.push({ text: listed, list });
            if (placed.contrasts) continue;
          }
          listed.report = colorReport(context, listed.keyword);
        } else if (text) {
          (listed.report?.fix ? fixedTexts : texts).push({ text: listed, list });
        }
      }
    }
    for (const { text, list } of texts) surfaces.holdUnderText(text, list);
    for (const list of lists.values()) keepStatesApart(list);
    // A text whose fix gave way to its state class stays as it is too.
    const stays = new Set(texts.map(({ text }) => text));
    for (const { text, list } of fixedTexts) {
      if (text.report?.fix) continue;
      stays.add(text);
      surfaces.holdUnderText(text, list);
    }
    surfaces.holdUnderInherited(stays);
    for (const list of lists.values()) {
      for (const { report } of list) if (report) context.report(report);
    }

    for (const { object, element } of context.analysis.styles) {
      for (const prop of object.properties) {
        if (!ts.isPropertyAssignment(prop)) continue;
        const name = propertyName(prop.name);
        if (name === undefined || !(name in STYLE_COLOR_PROPERTIES)) continue;
        // `isPressed ? "#ef4444" : undefined`: each literal branch is a value.
        for (const value of valueBranches(prop.initializer)) {
          if (!ts.isStringLiteralLike(value)) continue;
          reportLiteralColors(context, value, element, {
            where: `style.${name}`,
            prefix: STYLE_COLOR_PROPERTIES[name],
            place: 'style',
            named: true,
            allow,
          });
        }
      }
    }

    for (const element of context.analysis.elements) {
      // On native and SVG elements `color` and `fill` are colors. On a component
      // they are props, often a variant (`<Badge color="green">`): skip props with
      // known values, and read only hex and color functions as colors.
      const resolution = context.resolve(element);
      for (const attribute of element.attributes) {
        const name = attributeName(attribute);
        if (!isColorAttribute(name)) continue;
        if (
          resolution.kind === 'component' &&
          resolution.component.props.some((p) => p.name === name && p.values?.length)
        ) {
          continue;
        }
        const prefix = name === 'fill' || name === 'stroke' ? name : 'text';
        for (const literal of literalValues(attribute)) {
          if (
            (name === 'stopColor' || name === 'stop-color') &&
            element.tag === 'stop' &&
            MASK_LUMINANCE.has(literal.text.toLowerCase()) &&
            (isInsideMask(element) || maskGradients.has(gradientIdOfStop(element) ?? ''))
          ) {
            continue;
          }
          reportLiteralColors(context, literal, element, {
            where: `${name}="…"`,
            prefix,
            place: 'attribute',
            named: resolution.kind === 'intrinsic',
            allow,
          });
        }
      }
    }

    reportChartTokens(context, allow);
  },
});

/** The longest code a message quotes. */
const QUOTED_CODE = 120;

/**
 * The rule, with each `code` span in its messages cut to QUOTED_CODE characters. A message quotes
 * the class, its fix and the value whole, so one class with 33,000 `hover:` variants made a
 * message of 400,000 characters for the agent to read.
 */
function shortQuotes(rule: Rule): Rule {
  const cut = (span: string, code: string) =>
    code.length > QUOTED_CODE ? `\`${truncate(code, QUOTED_CODE)}\`` : span;
  return {
    ...rule,
    run(context) {
      rule.run({
        ...context,
        report(report) {
          context.report({ ...report, message: report.message.replace(/`([^`]+)`/g, cut) });
        },
      });
    },
  };
}

/** Packages that draw charts: Recharts, Chart.js, Nivo, visx, Victory, Tremor, MUI X Charts, D3. */
const CHART_LIBRARY = /chart|^@nivo\/|^@visx\/|^victory|^@tremor\/|^d3(?:-|$)/i;

/** Roles of an element that is a drawing: a chart drawn by hand is an image. */
const DRAWING_ROLE = /^(?:img|figure|graphics-[a-z]+)$/;

const CHART_TOKEN =
  'is a chart color, and this is not a chart: it changes with the chart palette, and it does not say what a status or brand color says. For a status color, add a token for it to the theme, such as `--success`; otherwise use the semantic token that fits.';

/**
 * Warns on a chart token outside a chart: `text-chart-2` on a green "Active" label in a theme
 * with no success color. The class is a token, so the color rule would call it clean, but it
 * says nothing a status or brand color says, and it changes with the chart palette (a gray or a
 * blue in some shadcn/ui themes). A file that draws a chart is in scope throughout, legend dots
 * and all: one that imports a chart library, renders a tag such as `<ChartContainer>` or
 * `<BarChart>`, declares a name such as `chartData`, or is named for charts. So is an element
 * in a drawing (`<svg>`, `role="img"`), as a chart drawn by hand is. When the design system's
 * own components use chart tokens outside a chart, they are a palette it shares: nothing is
 * reported.
 */
function reportChartTokens(context: RuleContext, allow: ReadonlySet<string>): void {
  const { tokens } = context.target;
  if (!tokens.scopedFamilies.has('chart')) return;
  const chart = new Set<ScopedFamily>(['chart']);
  const shared = [...(tokens.familyFiles.get('chart') ?? [])];
  if (shared.some((file) => !scopesIn(chart, file).size)) return;
  const { elements, imports, declared } = context.analysis;
  const names = [context.file, ...elements.map((e) => e.tag), ...declared];
  if (scopesIn(chart, ...names).size) return;
  if ([...imports.values()].some((binding) => CHART_LIBRARY.test(binding.source))) return;
  for (const classString of context.analysis.classStrings) {
    const { element } = classString;
    if (element && inDrawing(element)) continue;
    for (const cls of splitClasses(classString.text, classString.start)) {
      const key = COLOR_UTILITY.exec(parseUtility(cls.value).base)?.[1];
      if (!key?.startsWith('chart-') || !tokens.colorKeys.has(key)) continue;
      if (allow.has(cls.value.toLowerCase())) continue;
      context.report({
        start: cls.start,
        end: cls.end,
        message: `\`${cls.value}\` ${CHART_TOKEN}`,
        severity: 'warning',
      });
    }
  }
}

/** Whether the element is, or is in, a drawing: an `<svg>`, a `<figure>` or a `role="img"`. */
function inDrawing(element: JsxNode): boolean {
  const drawing = ts.findAncestor(element.node, (node) => {
    if (!ts.isJsxElement(node) && !ts.isJsxSelfClosingElement(node)) return false;
    const opening = ts.isJsxElement(node) ? node.openingElement : node;
    const tag = opening.tagName.getText(element.node.getSourceFile());
    if (tag === 'svg' || tag === 'figure') return true;
    return opening.attributes.properties.some(
      (attribute) =>
        ts.isJsxAttribute(attribute) &&
        attributeName(attribute) === 'role' &&
        literalValues(attribute).some((value) => DRAWING_ROLE.test(value.text)),
    );
  });
  return drawing !== undefined;
}

function reportLiteralColors(
  context: RuleContext,
  literal: ts.StringLiteralLike,
  element: JsxNode,
  options: {
    where: string;
    prefix: string | undefined;
    place: 'style' | 'attribute';
    /** Whether a named color (`red`) counts, as it does in CSS but not in a component's prop. */
    named: boolean;
    allow: Set<string>;
  },
): void {
  const start = literal.getStart(context.sourceFile) + 1;
  // Match the source as written: offsets into `literal.text` drift after an escape such as `\"`.
  const text = context.text.slice(start, literal.end - 1);
  const matches = findColorLiterals(text);
  const trimmed = text.trim();
  if (!matches.length && options.named && isNamedColor(trimmed)) {
    const color = parseColor(trimmed);
    if (color) matches.push({ text: trimmed, index: text.indexOf(trimmed), color });
  }
  for (const match of matches) {
    if (options.allow.has(match.text.toLowerCase())) continue;
    const report = colorReport(context, {
      start: start + match.index,
      end: start + match.index + match.text.length,
      what: `Hardcoded color \`${match.text}\` in ${options.where}`,
      color: match.color,
      prefix: options.prefix,
      place: options.place,
      element,
    });
    if (report) context.report(report);
  }
}

interface ColorInput {
  start: number;
  end: number;
  what: string;
  color: Oklch;
  /** A hue rather than a gray, when the source says so (`bg-sky-50` is blue, however pale). */
  tinted?: boolean;
  /** The default-palette color the class names (`neutral-600`), whose shade a fix must keep. */
  palette?: string;
  /** Tailwind prefix to build the replacement class with (`bg`, `text`, `border-t`). */
  prefix: string | undefined;
  /**
   * Where the literal sits: a class list (replace the class), a style value
   * (replace with `var(--token)`), or a JSX attribute such as `fill` or an
   * icon's `color` (move it to className; SVG attributes cannot use `var()`).
   */
  place: 'class' | 'style' | 'attribute';
  utility?: Utility;
  element?: JsxNode | undefined;
  /** The class string the color is in, which can place it in a sidebar or chart. */
  classes?: string | undefined;
  /**
   * `white` or `black` (`bg-white`, `text-black`): fixed only to a token of exactly that color,
   * and text in them only named, as a warning, since it depends on the surface under it.
   */
  keyword?: boolean;
}

/** The finding for a color, or undefined when the design system has no color to name. */
function colorReport(context: RuleContext, input: ColorInput): Report | undefined {
  const role = colorRole(input.prefix ?? input.utility?.prefix);
  // `dark:bg-slate-900` is the dark-mode color: compare it with the tokens' dark values.
  const mode = input.utility?.variants.includes('dark') ? 'dark' : undefined;
  const suggestion = context.target.tokens.suggestColor(input.color, {
    role,
    scopes: scopes(context, input.element, input.classes),
    tinted: input.tinted,
    mode,
  });
  if (!suggestion) return undefined;
  const { match, nearest, reason, sameValue, hueOff, otherRole, closeStatus } = suggestion;
  const token = nearest.candidate.token;

  const { cls, replacement, advice, edit } = writing(input, token);
  const close = match !== undefined;
  // A palette class names one color of a designed scale, so a token of another color is suggested
  // but not applied (see `heldBack`). One that copies Tailwind v3's shade still is: v3's red-600
  // (#dc2626), which Dub's `content-error` holds, is ΔE 0.030 from v4's.
  const held =
    close && input.palette && nearest.distance >= SAME_COLOR
      ? heldBack(input.palette, valueIn(nearest.candidate, mode), nearest.distance)
      : undefined;
  // A status color of the hue about as close as the match (`destructive` for red-500 next to a
  // rose `brand`): the color may say what happened, which the next rebrand must not change.
  const status =
    close && closeStatus ? statusTooClose(input, mode, closeStatus, token, advice) : undefined;
  const variant = cls && input.element ? variantApplying(context, input.element, cls) : undefined;

  const same = sameValue.length ? `, same value as ${sameValue.map((t) => t.name).join(', ')}` : '';
  const inMode = mode && token.modes?.[mode] !== undefined ? ` in ${mode} mode` : '';
  const value = valueIn(nearest.candidate, mode);
  const found = `${token.name}${inMode} (${formatDistance(input.color, value)}${same})`;
  // A translucent color is not its opaque token (`bg-[#e7000b33]` is not `bg-destructive`): say
  // both opacities, so the agent can keep it with an opacity modifier (`bg-destructive/20`).
  const opacityGap = formatOpacityGap(input.color, value, `${token.name}${inMode}`);
  const tinted = input.tinted ?? isTinted(input.color);
  // No token has the color's hue (a status green in a stock shadcn/ui theme). Naming the nearest,
  // a gray or another hue's token (`chart-2` in a chart), led agents to swap the meaning away, so
  // the message names none and leaves two ways out, as a warning.
  const noHue = !close && reason === 'hue' && tinted;
  // White and black: text in them depends on the surface under it, so it is named, as a warning;
  // anything else is fixed only to a token of exactly that color (`bg-white` → `bg-background`).
  const keywordText = input.keyword === true && role === 'text';
  const keptBack =
    input.keyword && close && edit && !held && !status
      ? keywordText
        ? 'White or black text depends on the surface under it, so this is not applied automatically: use the foreground token of that surface.'
        : nearest.distance >= SAME_COLOR
          ? 'Only a token of exactly this color is applied automatically.'
          : undefined
      : undefined;
  let message: string;
  if (close) {
    message = `${input.what}. ${nearest.distance < SAME_COLOR ? 'Matches token' : 'Nearest token'} ${found}`;
    if (advice) message += ` → ${advice}`;
    if (variant) message += `, or use ${variant}`;
    message += '.';
    if (opacityGap) message += ` ${opacityGap}`;
    if (status) message += ` ${status}`;
    else if (held) message += ` ${held}`;
    else if (keptBack) message += ` ${keptBack}`;
  } else if (noHue) {
    message = `${input.what}. ${NO_TOKEN_HAS_HUE}`;
  } else {
    message = `${input.what}. ${noMatch(reason, role, found, hueOff)}${meantForAnother(otherRole, input.color, mode)}${opacityGap ? ` ${opacityGap}` : ''} Pick the semantic token that fits.`;
  }
  const owner =
    !variant && input.prefix && input.element
      ? variantProp(context, input.element, input.prefix)
      : undefined;
  if (owner)
    message += ` <${owner.component}> already sets ${input.prefix}-* through \`${owner.prop}\`; prefer a variant over overriding it.`;

  return {
    start: input.start,
    end: input.end,
    message,
    suggestion: close ? (variant ?? replacement) : undefined,
    fix:
      close && edit && !held && !status && !keptBack
        ? [{ range: [input.start, input.end], text: edit }]
        : undefined,
    severity: noHue || keywordText ? 'warning' : undefined,
  };
}

/**
 * How code writes `token` where the color is: the class (`bg-primary`), what to suggest, the
 * message's advice and the text a fix puts in place of the color.
 */
function writing(
  input: ColorInput,
  token: Token,
): { cls?: string; replacement?: string; advice?: string; edit?: string } {
  const cls = input.prefix && token.tailwind ? `${input.prefix}-${token.tailwind}` : undefined;
  const cssVar = cssReference(token);
  let replacement: string | undefined;
  let advice: string | undefined;
  let edit: string | undefined;
  if (input.place === 'class') {
    replacement = cls ?? (cssVar && input.prefix ? `${input.prefix}-[${cssVar}]` : cssVar);
    if (replacement)
      advice = `\`${input.utility && input.prefix ? withBase(input.utility, replacement) : replacement}\``;
    if (replacement && input.prefix && input.utility) edit = withBase(input.utility, replacement);
  } else if (input.place === 'style') {
    replacement = cls ?? cssVar;
    advice = [cls, cssVar]
      .filter(Boolean)
      .map((v) => `\`${String(v)}\``)
      .join(' or ');
    edit = cssVar;
  } else {
    replacement = cls ? `className="${cls}"` : cssVar;
    advice = cls ? `\`${cls}\` in className` : undefined;
  }
  // Neither a class nor a custom property (a color of an MUI theme): how the token says to use it.
  if (!cls && !cssVar && token.usage.length) {
    advice = token.usage.map((usage) => `\`${usage}\``).join(' or ');
  }
  return { cls, replacement, advice, edit };
}

/**
 * Why a close match is not applied when a status color of the color's hue is about as close:
 * `destructive is close too (ΔE 0.071), and it is a status color, so this is not applied
 * automatically: use \`bg-destructive\` if the color shows a status, otherwise \`bg-brand\`.`
 */
function statusTooClose(
  input: ColorInput,
  mode: string | undefined,
  status: Nearest<ColorCandidate>,
  found: Token,
  advice: string | undefined,
): string {
  const { token } = status.candidate;
  const inMode = mode && token.modes?.[mode] !== undefined ? ` in ${mode} mode` : '';
  const distance = formatDistance(input.color, valueIn(status.candidate, mode));
  const statusAdvice = writing(input, token).advice || token.name;
  return `${token.name}${inMode} is close too (${distance}), and it is a status color, so this is not applied automatically: use ${statusAdvice} if the color shows a status, otherwise ${advice || found.name}.`;
}

/** A class in a class list, with its hardcoded color and its finding if it has them. */
interface ListedClass {
  value: string;
  /** The Tailwind prefix of the color the class sets (`bg`), when it sets one. */
  prefix?: string | undefined;
  /** The color the class hardcodes (`bg-[#fff]`, `bg-neutral-100`), which no mode changes. */
  color?: Oklch | undefined;
  /** A hue rather than a gray, when the class says so (`text-green-800`, not `text-gray-700`). */
  tinted?: boolean | undefined;
  /** The element whose class list it is in, if any. */
  element?: JsxNode | undefined;
  report?: Report | undefined;
  /** A white or black class (`bg-white`), reported once the whole list is known. */
  keyword?: ColorInput | undefined;
}

/** Color keywords that are no token but set a color (`bg-white`, `border-transparent`). */
const KEYWORD_COLORS = new Set(['white', 'black', 'transparent', 'current', 'inherit']);

/** The prefix of a class that sets a token's color or a keyword color: `bg` for `bg-primary`. */
function tokenColorPrefix(utility: Utility, colorKeys: ReadonlySet<string>): string | undefined {
  const key = COLOR_UTILITY.exec(utility.base)?.[1];
  if (!key || !(colorKeys.has(key) || KEYWORD_COLORS.has(key))) return undefined;
  return utility.base.slice(0, -key.length - 1);
}

/** `bg-white`, `border-black`: Tailwind's colors without a shade, as a color utility sets them. */
const KEYWORD_CLASS = new RegExp(
  `^(${COLOR_PREFIXES.join('|')})-(${Object.keys(TAILWIND_KEYWORD_COLORS).join('|')})$`,
);

/**
 * The white or black an opaque class sets (`bg-white`, `text-black`). With an opacity modifier
 * (`bg-black/50`, `border-white/10`) it is a tint of whatever is under it, a scrim or a hairline
 * that suits both modes, so it is left alone: with `tint`, only such a class is read. A theme
 * that defines `--color-white` (after `--color-*: initial`) makes `bg-white` one of its tokens.
 */
function keywordColor(
  utility: Utility,
  colorKeys: ReadonlySet<string>,
  tint = false,
): { prefix: string; color: Oklch } | undefined {
  if (Boolean(utility.modifier) !== tint || utility.arbitrary !== undefined) return undefined;
  const [, prefix, name] = KEYWORD_CLASS.exec(utility.base) ?? [];
  if (!prefix || !name || colorKeys.has(name)) return undefined;
  const color = parseColor(TAILWIND_KEYWORD_COLORS[name] ?? '');
  return color ? { prefix, color } : undefined;
}

/** The node around `node`, or undefined at the file. */
function parentOf(node: ts.Node): ts.Node | undefined {
  return ts.isSourceFile(node) ? undefined : node.parent;
}

/** Background classes that set no background of their own: what is under them shows through. */
const NO_BACKGROUND = /^bg-(?:transparent|current|inherit|none)$/;

/** Style properties that set an element's background, and values that set none. */
const STYLE_BACKGROUNDS = new Set(['background', 'backgroundColor', 'backgroundImage']);
const NO_STYLE_BACKGROUND = /^(?:transparent|none|inherit|initial|unset|revert|currentcolor)$/i;

/** `var(--primary)`: a custom property, which can be a token's. */
const CSS_VARIABLE = /^var\(\s*(--[\w-]+)\s*\)$/;

/**
 * How far apart in lightness (OKLCH L) white or black text and its surface must be for the
 * surface to be the text's own: white on `bg-indigo-600` or `bg-orange-500` (0.705), not on
 * `bg-amber-400` or `bg-muted`; black on `bg-yellow-300`, not on `bg-indigo-600`. A token is
 * judged in each mode the text shows in: shadcn/ui's `primary` is near white in dark mode, so
 * white text on `bg-primary` is not its own there.
 */
const SURFACE_CONTRAST = 0.25;

/** Whether text of this color stands out from a surface of this color. */
function standsOut(surface: Oklch, text: Oklch): boolean {
  return Math.abs(surface.l - text.l) >= SURFACE_CONTRAST;
}

/**
 * WCAG's least contrast for large text and the parts of a control. Lightness alone says too
 * little near black: `text-neutral-600` is 0.44 lighter than black and has 2.7:1 on it, and
 * `text-neutral-800` 1.6:1.
 */
const TEXT_CONTRAST = 3;

/** How hardcoded text reads on a surface: far enough apart in lightness, and in WCAG contrast. */
function legibility(surface: Oklch, text: Oklch): { apart: boolean; contrast: boolean } {
  return {
    apart: standsOut(surface, text),
    contrast: wcagContrast(surface, text) >= TEXT_CONTRAST,
  };
}

/** Hardcoded text as its surfaces see it: its color, its variants and its element. */
interface Paint {
  color: Oklch;
  variants: readonly string[];
  element: JsxNode | undefined;
}

/** The color a text, fill or stroke class hardcodes, or undefined when it sets none. */
function paintOf(text: ListedClass): Paint | undefined {
  if (colorRole(text.prefix) !== 'text' || !text.color) return undefined;
  return { color: text.color, variants: parseUtility(text.value).variants, element: text.element };
}

/** What hardcoded text sits on, in the mode where it stands out least. */
interface Placement {
  /** Whether it stands out from what it sits on in each mode it shows in. */
  contrasts: boolean;
  /** The class list that sets that surface: the one it does not stand out from, if any. */
  under?: readonly ListedClass[] | undefined;
}

/** A background's color in a mode: `unknown` when one is set but its color cannot be read. */
type SurfaceColor = Oklch | 'unknown';

/**
 * Where white or black text sits, which says whether the text is the surface's contrast color
 * (shadcn/ui's `bg-destructive text-white`) or the theme's: the background its own element sets,
 * in `style` or in its class list, its component's variants set (`<Button>` with `bg-*`
 * variants), or the nearest element around it that sets one. Any other hardcoded text is placed
 * the same way, to hold the fix of a background it would not stand out from.
 */
class Surfaces {
  private readonly byNode = new Map<ts.Node, JsxNode>();
  private readonly tokenColors = new Map<string, ColorCandidate>();
  private readonly byVar = new Map<string, ColorCandidate>();
  /** Backgrounds an element sets in `style`: each value's color, by mode. */
  private readonly styled = new Map<ts.Node, ((mode: string | undefined) => SurfaceColor)[]>();
  private readonly held = new Set<ListedClass>();
  private readonly placed = new Map<ListedClass, Placement>();

  constructor(
    private readonly context: RuleContext,
    private readonly lists: ReadonlyMap<object, readonly ListedClass[]>,
  ) {
    for (const element of context.analysis.elements) this.byNode.set(element.node, element);
    for (const candidate of context.target.tokens.colors) {
      const { tailwind, cssVar } = candidate.token;
      if (tailwind) this.tokenColors.set(tailwind, candidate);
      if (cssVar) this.byVar.set(cssVar, candidate);
    }
    // `style={{ backgroundColor: swatch }}`: a surface whose color is known only at run time.
    for (const { element, object } of context.analysis.styles) {
      for (const prop of object.properties) {
        if (!ts.isPropertyAssignment(prop) && !ts.isShorthandPropertyAssignment(prop)) continue;
        const name = propertyName(prop.name);
        if (name === undefined || !STYLE_BACKGROUNDS.has(name)) continue;
        const values = ts.isPropertyAssignment(prop)
          ? valueBranches(prop.initializer)
          : [prop.name];
        const colors = this.styled.get(element.node) ?? [];
        for (const value of values) {
          const read = this.styleColor(value);
          if (read) colors.push(read);
        }
        if (colors.length) this.styled.set(element.node, colors);
      }
    }
  }

  /**
   * Where the text sits, in each mode it shows in: a `dark:` class in dark mode only, another
   * one in its base mode and in dark mode, unless its class list sets its dark color itself
   * (`text-black dark:text-white`). It is the surface's own only if it stands out in each.
   */
  place(list: readonly ListedClass[], text: ListedClass): Placement {
    let placed = this.placed.get(text);
    if (!placed) {
      const paint = paintOf(text);
      placed = paint ? this.placeInModes(list, text, paint) : { contrasts: true };
      this.placed.set(text, placed);
    }
    return placed;
  }

  private placeInModes(list: readonly ListedClass[], text: ListedClass, paint: Paint): Placement {
    const { variants } = paint;
    const modes: (string | undefined)[] = variants.includes('dark')
      ? ['dark']
      : hasDarkCounterpart(list, text)
        ? [undefined]
        : [undefined, 'dark'];
    let under: readonly ListedClass[] | undefined;
    for (const mode of modes) {
      const state =
        mode === 'dark' && !variants.includes('dark') ? [...variants, 'dark'] : variants;
      const placed = this.placeIn(list, paint, state, mode);
      if (!placed.contrasts) return placed;
      under ??= placed.under;
    }
    return { contrasts: true, under };
  }

  /**
   * Takes back the fix of a hardcoded background when hardcoded text on it stays as it is and may
   * no longer stand out: `bg-black text-white` or `bg-zinc-900 text-white` would become
   * `bg-primary text-white`, white on near white where `primary` is light (shadcn/ui's dark
   * mode), and `bg-white text-neutral-800` would become `bg-background text-neutral-800`, dark
   * gray on near black. The text is on the backgrounds of its own class list, in their states too
   * (`hover:bg-black`), and on the surface `place` finds for it.
   */
  holdUnderText(text: ListedClass, list: readonly ListedClass[]): void {
    this.holdUnder(text, list, list);
    const { under } = this.place(list, text);
    if (under && under !== list) this.holdUnder(text, list, under);
  }

  /**
   * Takes back the fixes of backgrounds whose text color comes from around them, as text color is
   * inherited: in `<div className="text-neutral-800"><p className="bg-white">` the paragraph is
   * dark gray on white. An element in between that sets a text color, or a component, which can
   * set one of its own, ends it. An element with nothing in it (a skeleton's `<span />`) shows no
   * text.
   */
  holdUnderInherited(stays: ReadonlySet<ListedClass>): void {
    for (const list of this.lists.values()) {
      const element = list[0]?.element;
      if (
        !element ||
        !element.children.some((c) => !(ts.isJsxText(c) && c.containsOnlyTriviaWhiteSpaces)) ||
        !list.some((listed) => listed.prefix === 'bg' && listed.report?.fix)
      ) {
        continue;
      }
      for (let node: ts.Node | undefined = element.node; node; node = parentOf(node)) {
        const around = this.byNode.get(node);
        if (!around) continue;
        if (this.context.resolve(around).kind !== 'intrinsic') break;
        const aroundList = this.lists.get(around) ?? [];
        const texts = aroundList.filter(
          (listed) =>
            listed.prefix === 'text' && !parseUtility(listed.value).variants.some(stylesAnother),
        );
        if (!texts.length) continue;
        if (around !== element) {
          for (const text of texts) if (stays.has(text)) this.holdUnder(text, aroundList, list);
        }
        break;
      }
    }
  }

  /**
   * Takes back the fixes of the backgrounds in `under` that the text would not stand out from.
   * The text loses a token in a mode where it has less than it had on the hardcoded background:
   * 0.25 of lightness apart, or 3:1 contrast. A token without other modes may still have a dark
   * one onsystem does not read (`.dark:not(.light)`), so it counts as changing there. The fix
   * stays when the token keeps that in every mode the text shows in, or the class lists set the
   * dark-mode background or text (`dark:bg-zinc-900`, `dark:text-white`).
   */
  private holdUnder(
    text: ListedClass,
    list: readonly ListedClass[],
    under: readonly ListedClass[],
  ): void {
    const paint = paintOf(text);
    if (!paint) return;
    const textIsDark = paint.variants.includes('dark');
    const textInDark = textIsDark || !hasDarkCounterpart(list, text);
    for (const surface of under) {
      const { report, color: surfaceColor } = surface;
      const fix = report?.fix?.[0];
      if (!report || !fix || !surfaceColor || surface.prefix !== 'bg' || this.held.has(surface))
        continue;
      // A `dark:` class is compared with the tokens' dark values: where it applies, it is the same.
      const surfaceUtility = parseUtility(surface.value);
      if (surfaceUtility.variants.includes('dark')) continue;
      const before = legibility(surfaceColor, paint.color);
      if (!before.apart && !before.contrast) continue;
      const token = this.fixedTo(fix.text);
      if (!token) continue;
      const surfaceInDark = !hasDarkCounterpart(under, surface);
      const modes: [string, Oklch | undefined][] = Object.entries(token.modes ?? {});
      const known = modes.length > 0;
      if (!known) modes.push(['dark', undefined]);
      const lost = modes
        .filter(([mode, value]) => {
          const shows = mode === 'dark' ? textInDark && surfaceInDark : !textIsDark;
          if (!shows) return false;
          if (value === undefined) return true;
          const after = legibility(value, paint.color);
          return (before.apart && !after.apart) || (before.contrast && !after.contrast);
        })
        .map(([mode]) => mode);
      if (!lost.length) continue;
      this.held.add(surface);
      const textUtility = parseUtility(text.value);
      const shade = KEYWORD_CLASS.exec(textUtility.base)?.[2] ?? 'as it is';
      const name = token.token.name;
      const why = !known
        ? `and ${name} may be another color in a dark mode`
        : `which would not stand out from ${name} in ${lost.includes('dark') ? 'dark mode' : `the ${lost[0] ?? ''} mode`}`;
      // In its own class list, the text changes in the background's state: `hover:text-…`.
      const variants = [...textUtility.variants];
      if (under === list) {
        for (const variant of surfaceUtility.variants) {
          if (!variants.includes(variant)) variants.push(variant);
        }
      }
      // A hue's text is not named the surface's foreground, a gray: the hue may say something.
      const tinted = text.tinted ?? isTinted(paint.color);
      const pair = tinted
        ? undefined
        : this.foregroundOf(token, { ...textUtility, variants }, text.prefix);
      report.message += ` \`${text.value}\` on it stays ${shade}, ${why}, so this is not applied automatically: change the text with it${pair ? `, to \`${pair}\`` : ''}.`;
      report.fix = undefined;
    }
  }

  /** The token a background's fix puts in: `bg-primary`, or `bg-[var(--chart-bg)]`. */
  private fixedTo(fixed: string): ColorCandidate | undefined {
    const utility = parseUtility(fixed);
    const variable =
      utility.arbitrary === undefined
        ? undefined
        : CSS_VARIABLE.exec(utility.arbitrary.trim())?.[1];
    if (variable) return this.byVar.get(variable);
    return this.tokenColors.get(utility.base.slice('bg-'.length));
  }

  /** The text class of the token made for text on `surface`: `text-foreground` on `background`. */
  private foregroundOf(
    surface: ColorCandidate,
    text: Utility,
    prefix: string | undefined,
  ): string | undefined {
    const key = surface.token.tailwind;
    if (!key || !prefix) return undefined;
    const pair = key === 'background' ? 'foreground' : `${key}-foreground`;
    return this.tokenColors.has(pair) ? withBase(text, `${prefix}-${pair}`) : undefined;
  }

  /**
   * Where the text sits in one mode, and the class list that says so. Under a tint it does not
   * stand out from (`bg-white/10` under white text), what is under the tint decides; with nothing
   * under it in the file, the page's `background` in that mode does.
   */
  private placeIn(
    list: readonly ListedClass[],
    text: Paint,
    state: readonly string[],
    mode: string | undefined,
  ): Placement {
    const { color, element } = text;
    /** Whether the text is under a tint it does not stand out from, which shows what is under it. */
    const seen = { through: false };
    /** What an element's `style`, then its class list, says: undefined to look further out. */
    const at = (
      node: ts.Node | undefined,
      classes: readonly ListedClass[],
      component: JsxNode | undefined,
    ): Placement | undefined => {
      const styled = node ? this.styleVerdict(node, color, mode) : undefined;
      if (styled === 'through') seen.through = true;
      if (styled !== undefined) return styled === 'through' ? undefined : { contrasts: styled };
      const says = this.verdict(classes, color, state, mode);
      if (says === 'through') seen.through = true;
      else if (says !== undefined) return { contrasts: says, under: classes };
      if (component && variantProp(this.context, component, 'bg')) return { contrasts: true };
      return undefined;
    };
    const own = at(element?.node, list, element);
    if (own) return own;
    for (let node = element?.node.parent; node; node = parentOf(node)) {
      const around = this.byNode.get(node);
      if (!around) continue;
      const placed = at(node, this.lists.get(around) ?? [], around);
      if (placed) return placed;
    }
    if (!seen.through) return { contrasts: false };
    const page = this.tokenColors.get('background');
    return { contrasts: !page || standsOut(valueIn(page, mode), color) };
  }

  /**
   * What a class list's background says for the text, or undefined when it sets none. Any
   * background the text stands out from is its own: a list holds the classes of every branch
   * of a `cn()` object, which never apply together. Then a tint it does not stand out from,
   * whose surface is under it: in dark mode, `bg-neutral-50 dark:bg-white/10` is a tint over the
   * page.
   */
  private verdict(
    list: readonly ListedClass[],
    text: Oklch,
    state: readonly string[],
    mode: string | undefined,
  ): boolean | 'through' | undefined {
    let verdict: boolean | 'through' | undefined;
    for (const { value } of list) {
      const says = this.excuses(parseUtility(value), text, state, mode);
      if (says === true) return true;
      if (says === 'through' || verdict === undefined) verdict = says ?? verdict;
    }
    return verdict;
  }

  /**
   * What a background set in `style` says for the text: an inline style is over the classes.
   * A color known only at run time (a swatch) or an image is a surface of its own.
   */
  private styleVerdict(
    node: ts.Node,
    text: Oklch,
    mode: string | undefined,
  ): boolean | 'through' | undefined {
    const colors = this.styled.get(node);
    if (!colors) return undefined;
    let verdict: boolean | 'through' = 'through';
    for (const read of colors) {
      const color = read(mode);
      if (color === 'unknown' || standsOut(color, text)) verdict = true;
      else if ((color.alpha ?? 1) >= 1) return false;
    }
    return verdict;
  }

  /** How a style value colors the background: undefined when it sets none. */
  private styleColor(
    value: ts.Expression,
  ): ((mode: string | undefined) => SurfaceColor) | undefined {
    if (value.kind === ts.SyntaxKind.NullKeyword) return undefined;
    if (ts.isIdentifier(value) && value.text === 'undefined') return undefined;
    if (!ts.isStringLiteralLike(value)) return () => 'unknown';
    const text = value.text.trim();
    if (!text || NO_STYLE_BACKGROUND.test(text)) return undefined;
    const variable = CSS_VARIABLE.exec(text)?.[1];
    const token = variable ? this.byVar.get(variable) : undefined;
    if (token) return (mode) => valueIn(token, mode);
    const color = parseColor(text);
    return () => color ?? 'unknown';
  }

  /**
   * Whether a class sets a surface the text contrasts with: a gradient, an image, or a color far
   * enough from the text's in lightness. An opaque `bg-white` or `bg-black` is the page's own
   * color, as hardcoded as the text. A tint (`bg-black/60`) is a surface where it stands out;
   * `bg-white/10` under white text shows what is under it (`through`). Undefined for a class
   * that sets no background, or sets one only in a state the text is not in: `hover:bg-red-600`
   * is the surface of `hover:text-white`, not of `text-white`.
   */
  private excuses(
    utility: Utility,
    text: Oklch,
    state: readonly string[],
    mode: string | undefined,
  ): boolean | 'through' | undefined {
    const { base, modifier } = utility;
    if (!utility.variants.every((variant) => state.includes(variant))) return undefined;
    if (/^(?:from|via)-/.test(base)) return true;
    if (!base.startsWith('bg-') || NO_BACKGROUND.test(base)) return undefined;
    if (keywordColor(utility, this.context.target.tokens.colorKeys)) return false;
    const color = this.backgroundColor(utility, mode);
    if (color === 'unknown') return true;
    const contrasts = standsOut(color, text);
    return modifier && !contrasts ? 'through' : contrasts;
  }

  /** The color a `bg-*` class sets in a mode: a token's, the palette's, or written in it. */
  private backgroundColor(utility: Utility, mode: string | undefined): SurfaceColor {
    const key = utility.base.slice('bg-'.length);
    const token = this.tokenColors.get(key);
    if (token) return valueIn(token, mode);
    const palette = paletteColor(utility.base);
    if (palette) return parseColor(palette.value) ?? 'unknown';
    const keyword = TAILWIND_KEYWORD_COLORS[key];
    if (keyword) return parseColor(keyword) ?? 'unknown';
    if (utility.arbitrary === undefined) return 'unknown';
    const value = utility.arbitrary.replace(/^color:/, '').trim();
    const shade = PALETTE_VARIABLE.exec(value)?.[1];
    const variable = shade ? undefined : CSS_VARIABLE.exec(value)?.[1];
    const viaVariable = variable ? this.byVar.get(variable) : undefined;
    if (viaVariable) return valueIn(viaVariable, mode);
    const color = shade ? paletteColor(`bg-${shade}`)?.value : value;
    return (color && parseColor(color)) || 'unknown';
  }
}

/**
 * Whether the class list sets the color of `listed` for dark mode too: `text-black dark:text-white`,
 * `bg-white dark:bg-zinc-900`. Only a class that adds `dark:` and nothing else to its variants,
 * whatever its color: `dark:bg-darkgray-50` names a color of a config onsystem may not read.
 */
function hasDarkCounterpart(list: readonly ListedClass[], listed: ListedClass): boolean {
  const { prefix } = listed;
  if (prefix === undefined) return false;
  const { variants } = parseUtility(listed.value);
  if (variants.includes('dark')) return false;
  return list.some((other) => {
    if (other === listed) return false;
    const theirs = parseUtility(other.value);
    if (other.prefix !== prefix && !(other.prefix === undefined && setsColor(theirs, prefix)))
      return false;
    return (
      theirs.variants.includes('dark') &&
      theirs.variants.every((variant) => variant === 'dark' || variants.includes(variant)) &&
      variants.every((variant) => theirs.variants.includes(variant))
    );
  });
}

/** Utilities of a color prefix that set no color: `bg-cover`, `text-sm`, `stroke-2`. */
const NOT_A_COLOR: Record<string, RegExp> = {
  bg: /^bg-(?:auto|cover|contain|fixed|local|scroll|repeat.*|no-repeat|center|(?:top|bottom|left|right)(?:-.*)?|clip-.*|origin-.*|blend-.*|gradient-.*|linear.*|radial.*|conic.*|none|size-.*|position-.*|\[url\(.*)$/,
  text: /^text-(?:xs|sm|base|lg|\d?xl|left|center|right|justify|start|end|wrap|nowrap|balance|pretty|ellipsis|clip|\[\d.*)$/,
  fill: /^fill-none$/,
  stroke: /^stroke-(?:none|\d.*|\[\d.*)$/,
};

/** Whether a class of no known color sets the color of `prefix`: `dark:bg-darkgray-50`. */
function setsColor(utility: Utility, prefix: string): boolean {
  if (!utility.base.startsWith(`${prefix}-`) || COLOR_UTILITY.exec(utility.base) === null)
    return false;
  if (utility.prefix !== undefined && utility.prefix !== prefix) return false;
  return !NOT_A_COLOR[prefix]?.test(utility.base);
}

/**
 * Takes back a fix that would make a class under a condition (`hover:`, `focus-visible:`, `md:`)
 * the same color as the class without it: `bg-[#2563eb] hover:bg-[#1d4ed8]` would become
 * `bg-primary hover:bg-primary`, and the hover would change nothing. The state class gives way
 * first; a base class does when the state class already has the token it would get. `dark:` is
 * no such condition: dark classes are compared with the tokens' dark values, where the same
 * token is right. Two hardcoded classes of exactly the same color keep their fixes: the
 * condition changed nothing before either (`border-red-500 focus:border-red-500` keeps an error
 * border red on focus), and a hardcoded color is the same in every mode. A token class is not:
 * the class list's `bg-primary` is another color in dark mode than a `hover:bg-[#171717]` next
 * to it. A `dark:` state class starts from the list's `dark:` class, when it has one.
 */
function keepStatesApart(list: readonly ListedClass[]): void {
  const after = (listed: ListedClass) => listed.report?.fix?.[0]?.text ?? listed.value;
  const order = new Map(list.map((listed, i) => [listed, i]));
  const parsed = new Map<string, Utility>();
  const parse = (text: string) => {
    let utility = parsed.get(text);
    if (!utility) {
      utility = parseUtility(text);
      parsed.set(text, utility);
    }
    return utility;
  };
  // A state and its base set the same utility once fixed (`bg-primary`, with the same modifier),
  // and classes that are the same once fixed pair alike. So the classes are kept by their text
  // once fixed, and those texts by utility: a list of thousands is not compared pair by pair.
  const byText = new Map<string, ListedClass[]>();
  const byUtility = new Map<string, Set<string>>();
  const utilityKey = (text: string) => `${parse(text).base}\0${parse(text).modifier}`;
  const place = (listed: ListedClass) => {
    const text = after(listed);
    const same = byText.get(text) ?? [];
    byText.set(text, same);
    // In list order, the order the first match is taken in.
    const index = order.get(listed) ?? 0;
    same.splice(same.findLastIndex((other) => (order.get(other) ?? 0) < index) + 1, 0, listed);
    const texts = byUtility.get(utilityKey(text)) ?? new Set();
    byUtility.set(utilityKey(text), texts.add(text));
  };
  const unplace = (listed: ListedClass) => {
    const text = after(listed);
    const same = byText.get(text) ?? [];
    same.splice(same.indexOf(listed), 1);
    if (!same.length) byUtility.get(utilityKey(text))?.delete(text);
  };
  for (const listed of list) place(listed);
  for (const pass of ['state', 'base'] as const) {
    for (const listed of list) {
      const { report } = listed;
      if (!report?.fix?.[0]) continue;
      const text = after(listed);
      let found: { other: ListedClass; state: Utility; conditions: string } | undefined;
      for (const otherText of byUtility.get(utilityKey(text)) ?? []) {
        // The same class once fixed: no condition between the two.
        if (otherText === text) continue;
        const [state, base] =
          pass === 'state' ? [parse(text), parse(otherText)] : [parse(otherText), parse(text)];
        const conditions = conditionsBetween(state, base);
        if (!conditions) continue;
        for (const other of byText.get(otherText) ?? []) {
          if (found && (order.get(other) ?? 0) > (order.get(found.other) ?? 0)) break;
          if (oneColor(listed.color, other.color)) continue;
          const [stateListed, baseListed] = pass === 'state' ? [listed, other] : [other, listed];
          if (hasDarkBase(list, stateListed, baseListed, state, base, after)) continue;
          found = { other, state, conditions };
          break;
        }
      }
      if (!found) continue;
      const { other, state, conditions } = found;
      const had =
        pass === 'base'
          ? `\`${other.value}\` is in the class list too`
          : after(other) === other.value
            ? `The class list already has \`${other.value}\``
            : `\`${other.value}\` becomes \`${after(other)}\` too`;
      const apart = state.modifier
        ? 'such as with another opacity modifier'
        : `such as with \`${withBase({ ...state, modifier: '/90' }, state.base)}\``;
      report.message += ` ${had}, so with this fix \`${conditions}\` would change nothing: it is not applied automatically. Keep the two apart, ${apart}.`;
      unplace(listed);
      report.fix = undefined;
      place(listed);
    }
  }
}

/**
 * Below this ΔE two hardcoded colors are one color written two ways: a palette class and its
 * hex (`neutral-100` is 0.00015 from `#f5f5f5`), or an OKLCH value rounded to hex (red-500 is
 * 0.00097 from `#fb2c36`). SAME_COLOR is too loose for this: `#fafafa` is 0.015 from `#fff`,
 * and a hover from one to the other is a change the fix must not remove.
 */
const ONE_COLOR = 0.003;

/** Whether two hardcoded colors are exactly one color, so one token for both changes nothing. */
function oneColor(a: Oklch | undefined, b: Oklch | undefined): boolean {
  return a !== undefined && b !== undefined && colorDistance(a, b) < ONE_COLOR;
}

/**
 * Whether the class list has the base class's dark-mode counterpart, which a `dark:` state class
 * starts from instead: with `bg-[#171717] dark:bg-[#0a0a0a]`, `dark:hover:` changes the dark
 * background, not `bg-[#171717]`. Only a class that adds `dark:` and nothing else to the base
 * class's variants counts: one that adds a condition (`group-hover:`) is off with it.
 */
function hasDarkBase(
  list: readonly ListedClass[],
  stateListed: ListedClass,
  baseListed: ListedClass,
  state: Utility,
  base: Utility,
  after: (listed: ListedClass) => string,
): boolean {
  if (baseListed.prefix === undefined) return false;
  if (base.variants.includes('dark') || !state.variants.includes('dark')) return false;
  return list.some((other) => {
    if (other === stateListed || other === baseListed || other.prefix !== baseListed.prefix)
      return false;
    const { variants } = parseUtility(after(other));
    return (
      variants.includes('dark') &&
      variants.every((variant) => variant === 'dark' || base.variants.includes(variant)) &&
      base.variants.every((variant) => variants.includes(variant))
    );
  });
}

/**
 * The conditions (`hover:`) under which `state` applies and `base` does too, when both are the
 * same color: undefined when they are not, or `state` adds no condition but `dark:`, or styles
 * another element (`placeholder:`, `prose-a:`), whose color the base class does not set.
 */
function conditionsBetween(state: Utility, base: Utility): string | undefined {
  if (state.base !== base.base || state.modifier !== base.modifier) return undefined;
  if (!base.variants.every((variant) => state.variants.includes(variant))) return undefined;
  const added = state.variants.filter((v) => v !== 'dark' && !base.variants.includes(v));
  if (added.some(stylesAnother)) return undefined;
  return added.length ? `${added.join(':')}:` : undefined;
}

/** Variants for a pseudo-element or other elements than the one the class is on. */
const OTHER_ELEMENT = new Set([
  '*',
  '**',
  'after',
  'backdrop',
  'before',
  'details-content',
  'file',
  'first-letter',
  'first-line',
  'marker',
  'placeholder',
  'selection',
]);

/**
 * Whether a variant styles something else than the element: a pseudo-element (`placeholder:`),
 * children (`*:`), the typography plugin's elements (`prose-a:`), or an arbitrary selector that
 * goes on from `&` (`[&>svg]:`, `[&_a]:`, `[&::after]:`), not one that only narrows it
 * (`[&:hover]:`, `[.dark_&]:`).
 */
function stylesAnother(variant: string): boolean {
  if (OTHER_ELEMENT.has(variant) || variant.startsWith('prose-')) return true;
  const selector = /^\[(.*)\]$/.exec(variant)?.[1];
  if (!selector?.includes('&')) return false;
  const after = selector.slice(selector.lastIndexOf('&') + 1).replace(/\([^()]*\)|\[[^\]]*\]/g, '');
  return /[_>+~]|::/.test(after);
}

/**
 * When no token has the color's hue: add one, or keep the color and say why. Between JSX
 * children a `//` line is text, which suppresses nothing and renders, so that place gets the
 * `{/* *\/}` form.
 */
const NO_TOKEN_HAS_HUE =
  'No token has this hue. Add a token for it to the theme, such as `--success` for a status color, or keep this color and give the reason on the line above: `// onsystem-disable-next-line no-hardcoded-color -- <reason>` (between JSX children, `{/* onsystem-disable-next-line no-hardcoded-color -- <reason> */}`).';

/**
 * The most Tailwind v3 and v4 differ on one shade, in ΔE: 0.036 for fuchsia-600,
 * under 0.01 for the grays. A token this close to a class's shade, and nearer it
 * than to the family's other shades, can be a v3 project's copy of it.
 */
const PALETTE_DRIFT = 0.037;

/** Tailwind's default palette as colors: family → its shades, lightest first. */
const PALETTE_SHADES = new Map<string, [shade: string, color: Oklch][]>();

/** A family's shades as colors, lightest first: `neutral` → 50, 100, … 950. */
function shadesOf(family: string): [shade: string, color: Oklch][] {
  let shades = PALETTE_SHADES.get(family);
  if (!shades) {
    shades = [];
    for (const [shade, value] of Object.entries(TAILWIND_PALETTE[family] ?? {})) {
      const parsed = parseColor(value);
      if (parsed) shades.push([shade, parsed]);
    }
    PALETTE_SHADES.set(family, shades);
  }
  return shades;
}

/** Index of the color in `colors` nearest to `color`, or -1 when there is none. */
function nearestOf(colors: readonly [string, Oklch][], color: Oklch): number {
  let index = -1;
  let best = Infinity;
  colors.forEach(([, value], i) => {
    const distance = colorDistance(color, value);
    if (distance < best) [index, best] = [i, distance];
  });
  return index;
}

/** The palette color nearest to `color` across every family (`neutral-500`). */
function nearestPaletteColor(color: Oklch): string | undefined {
  const all = Object.keys(TAILWIND_PALETTE).flatMap((family) =>
    shadesOf(family).map(([shade, value]): [string, Oklch] => [`${family}-${shade}`, value]),
  );
  return all[nearestOf(all, color)]?.[0];
}

/**
 * Why a token that is not an exact match for a palette class (`key`, `neutral-600`)
 * is suggested but not applied, or undefined when it may be: it is nearer another
 * shade of the family (Dub's `content-default`, neutral-700, for `text-neutral-600`),
 * or it is the class's shade but further from it than Tailwind v3 and v4 are from
 * each other (`content-subtle`, neutral-500, for `text-slate-500`).
 */
function heldBack(key: string, color: Oklch, distance: number): string | undefined {
  const [family = '', own = ''] = key.split('-');
  const shades = shadesOf(family);
  const from = shades.findIndex(([shade]) => shade === own);
  const to = nearestOf(shades, color);
  if (from === -1 || to === -1) return undefined;
  const steps = to - from;
  let what: string;
  let intended: string;
  if (steps) {
    const count = Math.abs(steps) === 1 ? 'one shade' : `${String(Math.abs(steps))} shades`;
    const way = steps > 0 ? 'darker' : 'lighter';
    what = `${count} ${way} (${family}-${shades[to]?.[0] ?? ''})`;
    intended = `the ${way} color`;
  } else {
    if (distance < PALETTE_DRIFT) return undefined;
    const closest = nearestPaletteColor(color);
    what =
      closest && closest !== key
        ? `closest to ${closest}, not ${key}`
        : `a different color from ${key}`;
    intended = 'that color';
  }
  return `That is ${what}, so it is not applied automatically: use it if ${intended} is intended, otherwise pick the semantic token that fits.`;
}

/** A token's value where the class applies: a `dark:` class takes its dark-mode value. */
function valueIn(candidate: ColorCandidate, mode: string | undefined): Oklch {
  return (mode && candidate.modes?.[mode]) || candidate.color;
}

/** `content-subtle has this color (exact match), but it is meant for text.` */
function meantForAnother(
  other: ColorSuggestion['otherRole'],
  color: Oklch,
  mode: string | undefined,
): string {
  if (!other) return '';
  const { token } = other.candidate;
  const role = tokenRole(token);
  const how = other.distance < SAME_COLOR ? 'has this color' : 'is close';
  const inMode = mode && token.modes?.[mode] !== undefined ? ` in ${mode} mode` : '';
  return ` ${token.name} ${how}${inMode} (${formatDistance(color, valueIn(other.candidate, mode))}), but it is meant for ${role ? ROLE_WORDS[role] : 'another role'}.`;
}

const ROLE_WORDS: Record<ColorRole, string> = {
  text: 'text',
  surface: 'backgrounds',
  line: 'borders',
};

/**
 * Why no token replaces the color, naming the nearest one (`found`). A tinted color
 * with no token of its hue gets `NO_TOKEN_HAS_HUE` instead, which names none.
 */
function noMatch(
  reason: ColorSuggestion['reason'],
  role: ColorRole | undefined,
  found: string,
  hueOff: number | undefined,
): string {
  if (reason === 'status') {
    return `Nearest is ${found}, a status color ${String(hueOff)}° away in hue; status colors are only suggested for their own hue.`;
  }
  if (reason === 'scoped') {
    return `Nearest is ${found}, a token one part of the UI uses (not this one).`;
  }
  if (reason === 'hue') return `No gray token is close; nearest is ${found}, which is tinted.`;
  if (reason === 'role' && role)
    return `No close token is meant for ${ROLE_WORDS[role]}; nearest is ${found}.`;
  return `No close token; nearest is ${found}.`;
}

/**
 * The scoped token families (sidebar, chart, and any a single file uses) the
 * code is in: the file, the element and the elements around it, or its classes.
 */
function scopes(
  context: RuleContext,
  element: JsxNode | undefined,
  classes: string | undefined,
): Set<ScopedFamily> {
  const tags: string[] = [];
  for (let node: ts.Node | undefined = element?.node; node; node = node.parent) {
    const tag = ts.isJsxElement(node)
      ? node.openingElement.tagName
      : ts.isJsxSelfClosingElement(node)
        ? node.tagName
        : undefined;
    const name = tag?.getText(context.sourceFile);
    // A page laid out next to the sidebar is not in it.
    if (name && !/^Sidebar(?:Provider|Inset)$/.test(name)) tags.push(name);
  }
  const { tokens, components } = context.target;
  const found = scopesIn(tokens.scopedFamilies, context.file, ...tags);
  if (classes) for (const family of classScopes(context, classes)) found.add(family);
  // Inside a component that uses a family (<CodeBlock> for syntax colors), its tokens fit.
  const files = new Set([context.file]);
  for (const tag of tags) {
    const file = components.get(tag)?.source.file;
    if (file) files.add(file);
  }
  for (const family of tokens.scopedFamilies) {
    const using = tokens.familyFiles.get(family);
    if (using && [...files].some((file) => using.has(file))) found.add(family);
  }
  return found;
}

/** The scoped families each class string of a check names, by its text. */
const classScopeCache = new WeakMap<RuleContext['analysis'], Map<string, Set<ScopedFamily>>>();

/**
 * The scoped families a class string names, read once per string and check: each color in it
 * asks, and reading the whole string again for each made a list of thousands quadratic.
 */
function classScopes(context: RuleContext, classes: string): ReadonlySet<ScopedFamily> {
  let cache = classScopeCache.get(context.analysis);
  if (!cache) {
    cache = new Map();
    classScopeCache.set(context.analysis, cache);
  }
  let found = cache.get(classes);
  if (!found) {
    found = scopesIn(context.target.tokens.scopedFamilies, classes);
    cache.set(classes, found);
  }
  return found;
}

/** The variant prop of the element's component that already sets `prefix-*` classes, if any. */
function variantProp(
  context: RuleContext,
  element: JsxNode,
  prefix: string,
): { component: string; prop: string } | undefined {
  const resolution = context.resolve(element);
  if (resolution.kind !== 'component') return undefined;
  const variant = resolution.component.variants.find((v) =>
    Object.values(v.classes).some((classes) =>
      classes.split(/\s+/).some((c) => c.startsWith(`${prefix}-`)),
    ),
  );
  return variant ? { component: resolution.component.name, prop: variant.name } : undefined;
}

/** `variant="destructive"` when a variant of the element's component already applies `cls`. */
function variantApplying(context: RuleContext, element: JsxNode, cls: string): string | undefined {
  const resolution = context.resolve(element);
  if (resolution.kind !== 'component') return undefined;
  for (const variant of resolution.component.variants) {
    for (const [value, classes] of Object.entries(variant.classes)) {
      if (classes.split(/\s+/).includes(cls)) return `${variant.name}="${value}"`;
    }
  }
  return undefined;
}

// ─── Spacing and radius ─────────────────────────────────────────────────────

interface LengthRuleSpec {
  category: 'spacing' | 'radius';
  prefixes: Set<string>;
  styleProperties: Record<string, string>;
}

/** The source text of a number in a style object, sign included: `6`, `-8`. */
function numberValue(init: ts.Expression): string | undefined {
  if (ts.isNumericLiteral(init)) return init.text;
  if (
    ts.isPrefixUnaryExpression(init) &&
    ts.isNumericLiteral(init.operand) &&
    (init.operator === ts.SyntaxKind.MinusToken || init.operator === ts.SyntaxKind.PlusToken)
  ) {
    return `${init.operator === ts.SyntaxKind.MinusToken ? '-' : ''}${init.operand.text}`;
  }
  return undefined;
}

function lengthRule(id: Rule['id'], description: string, spec: LengthRuleSpec): Rule {
  return shortQuotes({
    id,
    description,
    run(context) {
      const { tokens } = context.target;
      if (!tokens.has(spec.category)) return;
      const allow = new Set(context.options.allow ?? []);

      for (const classString of context.analysis.classStrings) {
        for (const token of splitClasses(classString.text, classString.start)) {
          const utility = parseUtility(token.value);
          if (
            !utility.prefix ||
            utility.arbitrary === undefined ||
            !spec.prefixes.has(utility.prefix)
          )
            continue;
          if (allow.has(token.value) || allow.has(utility.arbitrary)) continue;
          const px = lengthToPx(utility.arbitrary);
          if (px === undefined || px === 0) continue;
          // `-mt-[3px]` and `mt-[-3px]` are the same negative margin; the fix keeps the sign.
          const negative = utility.negative !== px < 0;
          if (negative && !NEGATIVE_PREFIXES.has(utility.prefix)) continue;
          const replacement = lengthReplacement(context, spec.category, px, utility.prefix);
          if (!replacement || unnamed(replacement)) continue;
          // Hairlines (issue #61): a value of 1px or less is left alone unless the scale has
          // that exact step (`py-[1px]` → `py-px`), since the nearest step (4px, say) would
          // change the layout. A negative one (`mt-[-1px]`, `-mt-[1px]`) is a deliberate border
          // overlap, so it is left alone even then; the sign is the margin's, not the value's.
          if (spec.category === 'spacing' && Math.abs(px) <= 1 && (!replacement.exact || negative))
            continue;
          const fixed = withBase({ ...utility, negative }, replacement.cls);
          // `px-[0.5em]` grows with the font, which no step of the scale does: 8px only at 16px.
          const relative = !replacement.pill && FONT_RELATIVE.test(utility.arbitrary.trim());
          const message = relative
            ? `\`${token.value}\` is font-relative: ${utility.arbitrary.trim()} is ${formatPx(px)} only at a 16px font. Nearest step: \`${fixed}\` (${formatPx(replacement.px)}), which does not grow with the font, so it is not applied automatically.`
            : replacement.exact
              ? `\`${token.value}\` is ${formatPx(px)}, which is on the ${spec.category} scale: use \`${fixed}\`.`
              : replacement.pill
                ? `\`${token.value}\` (${formatPx(px)}) is far above the radius scale, so it reads as fully rounded: use \`${fixed}\`.`
                : `Hardcoded ${spec.category} \`${token.value}\` (${formatPx(px)}) is off the scale. Nearest: \`${fixed}\` (${formatPx(replacement.px)})` +
                  (replacement.far ? ', too far off to replace automatically.' : '.');
          context.report({
            start: token.start,
            end: token.end,
            message,
            suggestion: fixed,
            fix:
              replacement.far || relative
                ? undefined
                : [{ range: [token.start, token.end], text: fixed }],
          });
        }
      }

      for (const { object } of context.analysis.styles) {
        for (const prop of object.properties) {
          if (!ts.isPropertyAssignment(prop)) continue;
          const name = propertyName(prop.name);
          const prefix = name === undefined ? undefined : spec.styleProperties[name];
          if (!prefix) continue;
          // `isPressed ? 6 : 0`: each branch is a value.
          for (const init of valueBranches(prop.initializer)) {
            const number = numberValue(init);
            const raw = number ?? (ts.isStringLiteralLike(init) ? init.text : undefined);
            if (raw === undefined || allow.has(raw)) continue;
            const values = raw.trim().split(/\s+/);
            const lengths = values.map((v) => (number !== undefined ? Number(v) : lengthToPx(v)));
            if (lengths.some((px) => px === undefined) || lengths.every((px) => px === 0)) continue;
            const px = lengths.find((v) => v !== 0) ?? 0;
            const negative = px < 0;
            if (negative && !NEGATIVE_PREFIXES.has(prefix)) continue;
            const replacement =
              values.length === 1
                ? lengthReplacement(context, spec.category, px, prefix)
                : undefined;
            if (replacement && unnamed(replacement)) continue;
            // Hairlines (issue #61): as for classes above. `replacement` is only set for a
            // single value, so `margin: "-1px 0"` is still reported, without a fix.
            if (
              replacement &&
              spec.category === 'spacing' &&
              Math.abs(px) <= 1 &&
              (!replacement.exact || negative)
            )
              continue;
            const cls = replacement && `${negative ? '-' : ''}${replacement.cls}`;
            const cssVar =
              replacement?.cssVar &&
              (negative ? `calc(${replacement.cssVar} * -1)` : replacement.cssVar);
            const shown = number !== undefined ? `${name}: ${raw}` : `${name}: "${raw}"`;
            const size = replacement?.pill ? 'fully rounded' : formatPx(replacement?.px ?? 0);
            const advice = replacement
              ? replacement.tailwind
                ? `Use \`${cls}\` (${size}) in className instead of an inline style.`
                : `Use \`${cssVar ?? cls}\` (${size}).`
              : `Use ${spec.category} tokens instead.`;
            // `padding: "0.5em"` grows with the font, which no step of the scale does.
            const relative =
              number === undefined &&
              !replacement?.pill &&
              values.some((v) => FONT_RELATIVE.test(v));
            context.report({
              start: init.getStart(context.sourceFile),
              end: init.end,
              message: relative
                ? `Hardcoded ${spec.category} \`${shown}\` in style, font-relative: ${formatPx(px)} only at a 16px font. ${advice} No step of the scale grows with the font, so it is not applied automatically.`
                : `Hardcoded ${spec.category} \`${shown}\` in style. ${advice}`,
              suggestion: replacement ? (replacement.tailwind ? cls : cssVar) : undefined,
              fix:
                replacement && !replacement.tailwind && cssVar && replacement.exact && !relative
                  ? [{ range: [init.getStart(context.sourceFile), init.end], text: `"${cssVar}"` }]
                  : undefined,
            });
          }
        }
      }
    },
  });
}

/**
 * A value on the scale whose token code cannot name, with neither a Tailwind class nor a
 * custom property (a DESIGN.md's `spacing.md`): there is nothing better to write.
 */
function unnamed(replacement: { exact: boolean; tailwind: boolean; cssVar?: string | undefined }) {
  return replacement.exact && !replacement.tailwind && !replacement.cssVar;
}

/** A length in `em`, relative to the element's font size (`0.5em`, not `0.5rem`). */
const FONT_RELATIVE = /^-?(?:\d+\.?\d*|\.\d+)em$/i;

/** The nearest step is "far" when it is off by more than half the value and more than 4px. */
const FAR_RATIO = 0.5;
const FAR_PX = 4;

function lengthReplacement(
  context: RuleContext,
  category: 'spacing' | 'radius',
  px: number,
  prefix: string,
):
  | {
      cls: string;
      px: number;
      exact: boolean;
      /** A fully rounded radius (`rounded-full`) for a value far above the scale. */
      pill: boolean;
      /** The nearest step is too far off to swap in without changing the design. */
      far: boolean;
      tailwind: boolean;
      cssVar?: string | undefined;
      token: Token;
    }
  | undefined {
  const nearest = context.target.tokens.nearestLength(category, px);
  if (!nearest) return undefined;
  const { candidate } = nearest;
  const exact = nearest.distance < 0.01;
  const pill = nearest.pill === true;
  const far = !exact && !pill && nearest.distance > Math.max(FAR_PX, Math.abs(px) * FAR_RATIO);
  const cssVar = candidate.token.cssVar ? `var(${candidate.token.cssVar})` : undefined;
  const common = { px: candidate.px, exact, pill, far, cssVar, token: candidate.token };
  if (candidate.key !== undefined) {
    const key = candidate.key === 'DEFAULT' ? '' : `-${candidate.key}`;
    return { ...common, cls: `${prefix}${key}`, tailwind: true };
  }
  return {
    ...common,
    cls: cssVar ? `${prefix}-[${cssVar}]` : `${prefix}-[${formatPx(candidate.px)}]`,
    tailwind: false,
  };
}

export const noHardcodedSpacing = lengthRule(
  'no-hardcoded-spacing',
  'Padding, margin and gap must use the spacing scale, not arbitrary px/rem values.',
  { category: 'spacing', prefixes: SPACING_PREFIXES, styleProperties: STYLE_SPACING_PROPERTIES },
);

export const noHardcodedRadius = lengthRule(
  'no-hardcoded-radius',
  'Border radius must use radius tokens, not arbitrary values.',
  { category: 'radius', prefixes: RADIUS_PREFIXES, styleProperties: STYLE_RADIUS_PROPERTIES },
);
