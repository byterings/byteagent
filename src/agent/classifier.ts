import type { Attachment, ExecutionMode, ModeSetting } from '../shared/protocol';

export type TaskIntent = 'question' | 'edit' | 'command' | 'other';
export type TaskScope = 'local' | 'related' | 'cross_module';
export type TaskRisk = 'low' | 'medium' | 'high';

export interface TaskClassification {
  mode: ExecutionMode;
  intent: TaskIntent;
  scope: TaskScope;
  risk: TaskRisk;
  /** Whether a check (tests, build, lint) is expected before calling the work done. */
  needsVerification: boolean;
  /**
   * How strongly the signals agree, from 0 to 1. It is a heuristic score
   * calibrated against the regression tests, not a probability.
   */
  confidence: number;
  reasons: string[];
  /** 'user' when the mode was chosen in the UI rather than inferred. */
  source: 'heuristic' | 'user';
}

export interface ClassifyInput {
  prompt: string;
  attachments: Attachment[];
  setting: ModeSetting;
}

const QUESTION_START =
  /^(what|why|how|where|when|which|who|whose|is|are|does|do|did|can|could|should|would|will|explain|describe|summari[sz]e|show me|tell me|list|find|locate|walk me through|give me (a|an) (overview|summary|tour)|help me understand)\b/i;

const EDIT_VERBS =
  /\b(add|adds|adding|fix|fixes|fixing|change|changing|update|updating|implement|implementing|refactor|refactoring|rename|renaming|remove|removing|delete|deleting|create|creating|write|writing|rewrite|rewriting|replace|replacing|migrate|migrating|convert|converting|move|moving|extract|extracting|introduce|introducing|build|building|make|set up|setup|wire|integrate|integrating|support|optimi[sz]e|clean up|cleanup|upgrade|port|generate|scaffold|split|merge|improve|adjust|tweak|insert|append|enable|disable|bump)\b/i;

const COMMAND_VERBS = /^(please\s+)?(run|execute|install|start|launch|rerun|re-run)\b/i;

const CROSS_MODULE: Array<[RegExp, string]> = [
  [/\b(across|throughout)\s+(the\s+)?(whole\s+|entire\s+)?(app|application|project|codebase|code base|repo|repository|api|system|modules?|services?)\b/i, 'Spans the whole project'],
  [/\b(entire|whole)\s+(app|application|project|codebase|code base|repo|repository|system)\b/i, 'Spans the whole project'],
  [/\b(every|all)\s+(the\s+)?(files?|modules?|components?|services?|endpoints?|routes?|pages?|screens?)\b/i, 'Touches every module of a kind'],
  [/\b(architecture|architectural|re-?architect|redesign|restructure|overhaul|rewrite the)\b/i, 'Architectural change'],
  [/\b(migrat(e|ion|ing))\b.{0,40}\b(to|from)\b/i, 'Migration from one technology to another'],
  [/\b(authentication|authori[sz]ation|auth)\s+(system|flow|layer|module|service)\b/i, 'Cross-cutting system (authentication)'],
  [/\b(multi-?tenan(t|cy)|role-?based access|rbac|internationali[sz]ation|i18n|localization|audit log(ging)?|caching layer|plugin system|event (bus|system)|permission system|billing|payment (system|flow|integration)|notification system|offline support|real-?time (sync|updates))\b/i, 'Cross-cutting feature'],
  [/\b(end[- ]to[- ]end|full[- ]stack|from scratch|new (module|service|subsystem|micro-?service))\b/i, 'Multi-layer feature'],
  [/\b(multi-?step|in (phases|stages|steps)|step by step plan|roadmap|milestones?)\b/i, 'Asks for staged work'],
];

const RELATED: Array<[RegExp, string]> = [
  [/\b(and|with|plus|including|also)\b.{0,30}\b(tests?|specs?|unit tests?)\b/i, 'Asks for a change together with tests'],
  [/\b(tests?|specs?)\b.{0,20}\bfor\b/i, 'Asks for tests'],
  [/\b(endpoint|route|api|controller|handler|middleware|resolver|model|schema|migration|component|page|screen|form|hook|service|command|cli option|feature flag)\b/i, 'Mentions a unit that usually has related files'],
  [/\b(also|as well|and then|and update|wherever it is used|all (callers|usages|references)|its callers|call sites?)\b/i, 'Follow-on changes in other places'],
  [/\b(new feature|feature)\b/i, 'Feature work'],
  [/\b(bug|regression|failing test|broken|crash(es|ing)?|exception|stack ?trace|error (when|while|on|in))\b/i, 'Bug investigation'],
];

const LOCAL: Array<[RegExp, string]> = [
  [/\b(typo|spelling|wording|comment|docstring|log message|label|placeholder|tooltip|copy text)\b/i, 'Small text change'],
  [/\b(colou?r|padding|margin|font|spacing|border|width|height|icon|alignment|css|style value)\b/i, 'Local style change'],
  [/\b(this (function|method|line|variable|file|class|block|selection|snippet)|the selected|selection)\b/i, 'Refers to one specific place'],
  [/\b(rename (the\s+)?(variable|parameter|argument|constant|local))\b/i, 'Local rename'],
  [/\b(constant|default value|timeout|threshold|limit|version number)\b/i, 'Single value change'],
];

const HIGH_RISK: Array<[RegExp, string]> = [
  [/\b(auth(entication|ori[sz]ation)?|login|sign[- ]?in|password|credential|token|session|oauth|jwt|sso|2fa|mfa|encryption|crypto(graphy)?|secret|permission|access control)\b/i, 'Security-sensitive area'],
  [/\b(payment|billing|invoice|checkout|refund|charge|subscription|pricing rules?|money|currency)\b/i, 'Money-related logic'],
  [/\b(database|schema|migration|sql|table|index|data loss|backfill|production data)\b/i, 'Database or data migration'],
  [/\b(production|prod|deploy(ment)?|release pipeline|ci\/cd|infrastructure|terraform|kubernetes|docker)\b/i, 'Deployment or infrastructure'],
  [/\b(delete|drop|purge|wipe|truncate|destroy)\b.{0,30}\b(data|records?|users?|accounts?|files?|tables?|rows?)\b/i, 'Deletes data'],
  [/\b(concurren(t|cy)|race condition|thread[- ]?safe|transaction|locking|deadlock)\b/i, 'Concurrency-sensitive logic'],
];

const AREAS: Array<[RegExp, string]> = [
  [/\b(front-?end|ui|client|react|vue|angular|page|screen|component)\b/i, 'frontend'],
  [/\b(back-?end|server|api|endpoint|route|controller|service)\b/i, 'backend'],
  [/\b(database|db|schema|migration|model|table|sql|orm)\b/i, 'database'],
  [/\b(tests?|specs?|e2e|integration tests?|unit tests?)\b/i, 'tests'],
  [/\b(docs?|documentation|readme|changelog)\b/i, 'docs'],
  [/\b(ci|pipeline|deploy|docker|infrastructure|config(uration)?)\b/i, 'infrastructure'],
];

function matches(table: Array<[RegExp, string]>, text: string): string[] {
  const found: string[] = [];
  for (const [pattern, label] of table) if (pattern.test(text) && !found.includes(label)) found.push(label);
  return found;
}

/** Counts separate things the request asks for. */
function countDeliverables(prompt: string): number {
  const listItems = prompt.split('\n').filter((line) => /^\s*(?:[-*•]|\d+[.)])\s+\S/.test(line)).length;
  if (listItems >= 2) return listItems;
  // "add X, Y and Z" style enumerations of substantial items.
  const clauses = prompt
    .split(/[.;\n]/)
    .flatMap((sentence) => sentence.split(/,|\band\b|\bplus\b|\bas well as\b/i))
    .map((c) => c.trim())
    .filter((c) => c.split(/\s+/).length >= 2);
  const actionable = clauses.filter((c) => EDIT_VERBS.test(c) || /\b(endpoint|route|page|screen|component|test|table|model|service|middleware|command|job|worker|form)s?\b/i.test(c));
  return actionable.length;
}

/**
 * Chooses an execution mode from the request text. Deterministic: the
 * same request always gets the same answer, and every answer explains
 * itself. The mode only controls how much context and planning is used;
 * review and approval rules do not depend on it.
 */
export function classifyTask(input: ClassifyInput): TaskClassification {
  const prompt = input.prompt.trim();
  const words = prompt.split(/\s+/).filter(Boolean).length;
  const firstLine = prompt.split('\n')[0] ?? '';

  const hasEditVerb = EDIT_VERBS.test(prompt);
  const startsAsQuestion = QUESTION_START.test(firstLine.replace(/^(hey|hi|hello|please|ok|okay|so)[,!\s]+/i, ''));
  const endsAsQuestion = /\?\s*$/.test(firstLine) || /\?\s*$/.test(prompt);
  // "Can you add…", "Could you fix…" are requests, not questions.
  const politeRequest = /^(can|could|would|will)\s+you\b/i.test(firstLine) || /^please\b/i.test(firstLine);
  const asksHowTo = /^(how (do|can|should|would) (i|we|you)|what('s| is) the best way)\b/i.test(firstLine);

  let intent: TaskIntent;
  if (COMMAND_VERBS.test(firstLine) && !/\b(and|then)\s+(fix|add|change|update|implement)\b/i.test(prompt)) intent = 'command';
  else if ((startsAsQuestion || endsAsQuestion) && (!hasEditVerb || asksHowTo) && !politeRequest) intent = 'question';
  else if (hasEditVerb) intent = 'edit';
  else if (startsAsQuestion || endsAsQuestion) intent = 'question';
  else intent = 'other';

  const cross = matches(CROSS_MODULE, prompt);
  const related = matches(RELATED, prompt);
  const local = matches(LOCAL, prompt);
  const highRisk = matches(HIGH_RISK, prompt);
  const areas = matches(AREAS, prompt);
  const deliverables = intent === 'edit' ? countDeliverables(prompt) : 0;
  const fileRefs = new Set([
    ...input.attachments.filter((a) => a.source !== 'active').map((a) => a.path),
    ...(prompt.match(/\b[\w./-]+\.(?:[a-z]{1,4}|[A-Za-z]{2,5})\b/g) ?? []).filter((m) => /[a-z]/i.test(m) && !/^\d/.test(m) && !/^(e\.g|i\.e|etc)\.?$/i.test(m)),
  ]);
  const hasSelection = input.attachments.some((a) => a.source === 'selection');

  const reasons: string[] = [];
  let scope: TaskScope = 'local';
  let signals = 0;
  let conflicts = 0;

  if (intent === 'question') {
    reasons.push('Asks a question; no file changes expected');
    signals += 1;
    if (cross.length > 0 || /\b(review|audit|assess|analy[sz]e)\b.{0,40}\b(project|codebase|architecture|repo|repository|security)\b/i.test(prompt)) {
      scope = 'related';
      reasons.push('The question covers a large part of the project');
    }
  } else if (intent === 'command') {
    reasons.push('Asks to run something');
    signals += 1;
  } else {
    if (cross.length > 0) {
      scope = 'cross_module';
      reasons.push(...cross.slice(0, 2));
      signals += cross.length;
    }
    if (deliverables >= 4) {
      scope = 'cross_module';
      reasons.push(`Lists ${deliverables} separate deliverables`);
      signals += 1;
    } else if (deliverables >= 2 && scope === 'local') {
      scope = 'related';
      reasons.push(`Asks for ${deliverables} things`);
      signals += 1;
    }
    if (areas.length >= 3) {
      scope = 'cross_module';
      reasons.push(`Involves several layers (${areas.slice(0, 4).join(', ')})`);
      signals += 1;
    }
    if (words > 150 && scope !== 'cross_module') {
      scope = scope === 'local' ? 'related' : 'cross_module';
      reasons.push('Long, detailed request');
      signals += 1;
    }
    if (scope === 'local' && (related.length > 0 || fileRefs.size >= 2)) {
      scope = 'related';
      if (fileRefs.size >= 2) reasons.push(`Names ${fileRefs.size} files`);
      reasons.push(...related.slice(0, 2));
      signals += related.length + (fileRefs.size >= 2 ? 1 : 0);
    } else if (scope === 'related' && related.length > 0) {
      // Already "related" for another reason: these hints explain it better.
      reasons.unshift(...related.slice(0, 2));
      signals += related.length;
    }
    if (local.length > 0 || hasSelection) {
      if (scope === 'local') {
        reasons.push(...(local.length > 0 ? local.slice(0, 2) : ['Works on your selection']));
        signals += local.length + (hasSelection ? 1 : 0);
      } else if (scope === 'related' && related.length <= 1 && deliverables < 2 && cross.length === 0 && (local.length >= 1 || hasSelection) && fileRefs.size < 2) {
        // "Change the button colour on the login page": local wins over one weak related hint.
        scope = 'local';
        reasons.length = 0;
        reasons.push(...(local.length > 0 ? local.slice(0, 2) : ['Works on your selection']));
        conflicts += 1;
      } else conflicts += 1;
    }
    if (reasons.length === 0) {
      reasons.push(intent === 'edit' ? 'Looks like a small, self-contained change' : 'No strong signals; starting small');
    }
  }

  let risk: TaskRisk = 'low';
  if (intent === 'edit' || intent === 'other') {
    if (highRisk.length > 0) {
      risk = scope === 'local' ? 'medium' : 'high';
      reasons.push(highRisk[0] as string);
    } else if (scope !== 'local') risk = 'medium';
  }

  let mode: ExecutionMode;
  if (intent === 'question') mode = scope === 'local' ? 'quick' : 'standard';
  else if (intent === 'command') mode = 'quick';
  else if (scope === 'cross_module') mode = 'project';
  else if (scope === 'related') mode = risk === 'high' && (deliverables >= 2 || areas.length >= 2) ? 'project' : 'standard';
  else mode = risk === 'medium' ? 'standard' : 'quick';

  if (mode === 'standard' && scope === 'local' && risk === 'medium') reasons.push('Sensitive area, so related code is checked first');
  if (mode === 'project' && scope === 'related') reasons.push('High-risk change with several parts, so it is planned and tracked');

  const needsVerification = intent === 'edit' && (mode !== 'quick' || risk !== 'low');

  // Agreement between signals raises the score; conflicts and silence lower it.
  let confidence = 0.45 + Math.min(signals, 4) * 0.1 - conflicts * 0.1;
  if (intent === 'other') confidence -= 0.1;
  if (words <= 3) confidence -= 0.1;
  confidence = Math.round(Math.max(0.2, Math.min(0.9, confidence)) * 100) / 100;

  if (input.setting !== 'auto') {
    return {
      mode: input.setting,
      intent,
      scope,
      risk,
      needsVerification: intent === 'edit' && (input.setting !== 'quick' || risk !== 'low'),
      confidence: 1,
      reasons: [`You chose ${input.setting[0]?.toUpperCase()}${input.setting.slice(1)} mode`, ...(mode !== input.setting ? [`ByteAgent would have picked ${mode[0]?.toUpperCase()}${mode.slice(1)}`] : [])],
      source: 'user',
    };
  }

  return { mode, intent, scope, risk, needsVerification, confidence, reasons: [...new Set(reasons)].slice(0, 4), source: 'heuristic' };
}

export interface EscalationSignals {
  /** Distinct files the model has proposed to change so far. */
  filesProposed: string[];
  /** Model round trips used so far. */
  steps: number;
  /** Distinct files read through tools. */
  filesRead: number;
}

export interface Escalation {
  to: ExecutionMode;
  reason: string;
}

function topLevelAreas(paths: string[]): number {
  return new Set(paths.map((p) => (p.includes('/') ? p.split('/').slice(0, p.startsWith('src/') || p.startsWith('packages/') || p.startsWith('apps/') ? 2 : 1).join('/') : '.'))).size;
}

/**
 * Decides whether the work has outgrown its mode. Called while a run is
 * in progress, with facts about what the run has actually done.
 */
export function checkEscalation(mode: ExecutionMode, signals: EscalationSignals): Escalation | undefined {
  const files = [...new Set(signals.filesProposed)];
  const areas = topLevelAreas(files);
  if (mode === 'quick') {
    if (files.length >= 6 || areas >= 4) return { to: 'project', reason: `The change touches ${files.length} files in ${areas} areas` };
    if (files.length >= 3) return { to: 'standard', reason: `The change touches ${files.length} files` };
    if (signals.filesRead >= 8) return { to: 'standard', reason: `${signals.filesRead} files had to be read` };
    if (signals.steps >= 9) return { to: 'standard', reason: 'The task is taking more steps than a quick task should' };
  } else if (mode === 'standard') {
    if (files.length >= 8 || areas >= 4) return { to: 'project', reason: `The change touches ${files.length} files in ${areas} areas` };
    if (signals.steps >= 20) return { to: 'project', reason: 'The task is taking more steps than a standard task should' };
  }
  return undefined;
}
