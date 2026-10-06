// SPDX-License-Identifier: GPL-3.0-only
const error = message => Object.assign(new Error(message), { code: 'DESKTOP_PROFILE' });
const textFields = ['role','name','value','automationId','description','className'];
export function substitute(value, variables = {}) {
  return value.replace(/\{(self|target|input|output)\}/g, (_match, name) => {
    if (typeof variables[name] !== 'string') throw error(`Missing exact ${name} evidence`);
    return variables[name];
  });
}
export function validateSelector(selector, depth = 0) {
  if (!selector || typeof selector !== 'object' || Array.isArray(selector) || depth > 3 || !textFields.some(key => typeof selector[key] === 'string' && selector[key].length > 0)) throw error('A selector requires an exact role/name/value/automationId/description; arbitrary regex/coordinates are unsupported');
  for (const [key, value] of Object.entries(selector)) {
    if (key === 'ancestor') { validateSelector(value, depth+1); continue; }
    if (!textFields.includes(key) || typeof value !== 'string' || value.length > 512) throw error('Unsupported or invalid accessibility selector field: ' + key);
  }
  return selector;
}
export function findNodes(snapshot, selector, variables = {}) {
  validateSelector(selector);
  const nodes = snapshot.nodes, byId = new Map(nodes.map(node=>[node.id,node]));
  const matches = (node, query) => {
    if (!node || node.visible !== true || node.protected) return false;
    if (textFields.some(key => query[key] !== undefined && node[key] !== substitute(query[key],variables))) return false;
    if (query.ancestor) {
      const seen = new Set(); let parent = byId.get(node.parentId), found = false;
      while (parent && !seen.has(parent.id)) { seen.add(parent.id); if (matches(parent,query.ancestor)) { found = true; break; } parent = byId.get(parent.parentId); }
      if (!found) return false;
    }
    return true;
  };
  return nodes.filter(node=>matches(node,selector));
}
export function exactNode(snapshot, selector, variables) {
  const nodes = findNodes(snapshot,selector,variables);
  if (nodes.length !== 1) throw error(`Accessibility selector matched ${nodes.length} controls; require exactly one`);
  return nodes[0];
}
export function matchesAll(snapshot, condition, variables) {
  const all = Array.isArray(condition) ? condition : condition?.all, none = Array.isArray(condition) ? [] : condition?.none ?? [];
  return Array.isArray(all) && all.length > 0 && all.every(selector=>findNodes(snapshot,selector,variables).length===1) && none.every(selector=>findNodes(snapshot,selector,variables).length===0);
}
export function validateProfile(profile) {
  if (profile?.formatVersion !== 1 || !['wechat','feishu','tencent-meeting'].includes(profile.platform) || !['linux','win32','darwin'].includes(profile.os)) throw error('Select a platform-specific desktop call profile');
  for (const field of ['identity','target','audioInput','audioOutput']) validateSelector(profile[field]);
  if (!profile.identity || !JSON.stringify(profile.identity).includes('{self}')) throw error('Identity selector must include the actual {self} account identifier');
  if (!JSON.stringify(profile.target).includes('{target}')) throw error('Target selector must include the actual {target} identifier');
  if (!JSON.stringify(profile.audioInput).includes('{input}') || !JSON.stringify(profile.audioOutput).includes('{output}')) throw error('Audio route selectors must verify configured {input} and {output} names');
  for (const state of ['idle','ringing','dialing','connected','ending']) if (profile.states?.[state] !== undefined) {
    const condition = profile.states[state], all = Array.isArray(condition) ? condition : condition?.all, none = Array.isArray(condition) ? [] : condition?.none ?? [];
    if (!Array.isArray(all) || !all.length || all.length > 10 || !Array.isArray(none) || none.length > 10) throw error('State evidence must be nonempty selector lists');
    [...all,...none].forEach(selector=>validateSelector(selector));
  }
  if (!profile.states?.idle || !profile.states?.connected) throw error('A profile needs positive idle and connected evidence');
  if (profile.evidenceMode !== undefined && !['continuous','preflight'].includes(profile.evidenceMode)) throw error('Unknown identity/audio evidence mode');
  if (profile.evidenceMode === 'preflight') {
    if (!Array.isArray(profile.preflight) || !profile.preflight.length || profile.preflight.length > 24) throw error('Preflight requires an explicit bounded settings navigation sequence');
    const verified = new Set();
    for (const step of profile.preflight) {
      if (step.kind === 'verify' && ['identity','audioInput','audioOutput'].includes(step.field)) { verified.add(step.field); continue; }
      if (!['invoke','assert'].includes(step.kind) || step.commit) throw error('Preflight may inspect/open settings but cannot write text or commit a call');
      validateSelector(step.selector); if (step.waitFor) validateSelector(step.waitFor);
    }
    if (verified.size !== 3) throw error('Preflight must verify identity and both virtual audio routes');
  }
  for (const [op, action] of Object.entries(profile.actions ?? {})) {
    if (!['dial','join','accept','reject','hangup'].includes(op) || !Array.isArray(action.steps) || !action.steps.length || action.steps.length > 12) throw error('Invalid desktop operation');
    if (!['direct','group'].includes(action.kind)) throw error('Operation must declare direct or group call kind');
    if (action.target) { validateSelector(action.target); if (!JSON.stringify(action.target).includes('{target}')) throw error('Operation target evidence must include {target}'); }
    const terminalStep = action.steps.at(-1);
    if (terminalStep.kind !== 'invoke' || terminalStep.commit !== true || action.steps.slice(0,-1).some(s=>s.commit)) throw error('The final invoke must be the single explicit call-control commit');
    for (const step of action.steps) {
      validateSelector(step.selector);
      if (!['invoke','setValue','assert'].includes(step.kind)) throw error('Only semantic invoke/setValue/assert are allowed');
      if (step.kind === 'setValue' && (typeof step.value !== 'string' || step.value.length > 512)) throw error('Text entry requires a bounded value');
      if (step.waitFor) validateSelector(step.waitFor);
    }
  }
  return profile;
}
