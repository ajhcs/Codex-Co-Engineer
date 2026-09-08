(function (global) {
  'use strict';

  var TOOL_CALL_METHOD = 'tools/' + 'call';
  var SHA40 = /^[a-fA-F0-9]{40}$/;
  var DIGEST = /^sha256:[0-9a-f]{64}$/;
  var TOKEN_PATTERNS = [
    /\b(?:sk|xai)-[A-Za-z0-9_-]{8,}\b/g,
    /\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_-]{8,}\b/g,
    /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
    /\bcrsr_[A-Za-z0-9_-]{12,}\b/g,
    /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  ];
  var OWNER_ONLY_KEYS = {
    raw: true,
    bytes: true,
    secret: true,
    secrets: true,
    credential: true,
    credentials: true,
    payload: true,
    stdout: true,
    stderr: true,
    prompt: true,
    argv: true,
    env: true,
    repository_path: true,
    worktree_path: true,
    agent_argv: true,
    cli_argv: true,
    approval_ref: true,
  };
  var INLINE_CARDS = { run: true, attention: true, final: true };
  var KNOWN_EVIDENCE_KINDS = {
    acceptance_results: true,
    artifact_integrity: true,
    command_reported: true,
    files_changed: true,
    git_diff: true,
    git_identity: true,
    head_reached: true,
    head_sha: true,
    model_attested: true,
    model_used: true,
    tests_passed: true,
  };
  var VERIFIED_FINAL_SENTENCE = 'Co-Engineer finished, and I verified the candidate.';
  var CODEX_AUTHORITY_SENTENCE =
    'Codex remains chief engineer, reviewer, and merge authority.';
  var DISPLAY_ONLY_NOTE =
    'Display only. This card cannot merge, push, rebase, create a pull request, tag, or release.';
  var NOT_AVAILABLE = 'Not available';
  var UNKNOWN = 'unknown';
  var TARGET_MAX = 128;
  var CHANGED_MAX = 512;
  var USAGE_MAX = 512;
  var EVIDENCE_REF_MAX = 16;
  var BRANCH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

  var OBJECTIVE_MAX = 512;
  var QUESTION_MAX = 320;
  var CONSENT_MESSAGE =
    'This run needs your approval to share the full repository with the selected co-engineers for this run.';

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, function (ch) {
      if (ch === '&') return '&amp;';
      if (ch === '<') return '&lt;';
      if (ch === '>') return '&gt;';
      if (ch === '"') return '&quot;';
      return '&#39;';
    });
  }

  function redactDisplay(value) {
    var text = String(value ?? '');
    for (var i = 0; i < TOKEN_PATTERNS.length; i += 1) {
      text = text.replace(TOKEN_PATTERNS[i], '[REDACTED]');
    }
    return text;
  }

  function clipText(value, maxChars) {
    var text = redactDisplay(value);
    if (text.length <= maxChars) return text;
    return text.slice(0, Math.max(0, maxChars - 1)) + '…';
  }

  function displayString(value, fallback) {
    if (typeof value !== 'string') return fallback || NOT_AVAILABLE;
    var clipped = clipText(value, OBJECTIVE_MAX).trim();
    return clipped === '' ? (fallback || NOT_AVAILABLE) : clipped;
  }

  function hasTerminalPunctuation(value) {
    return /[.!?]$/.test(value);
  }

  function joinRunPhrases(phrase, running) {
    var left = displayString(phrase);
    if (typeof running !== 'string') return left;
    var right = clipText(running, OBJECTIVE_MAX).trim();
    if (right === '') return left;
    return left + (hasTerminalPunctuation(left) ? ' ' : '. ') + right;
  }

  function sha40(value) {
    return typeof value === 'string' && SHA40.test(value) ? value.toLowerCase() : null;
  }

  function digestValue(value) {
    return typeof value === 'string' && DIGEST.test(value) ? value : null;
  }

  function branchNameOk(value) {
    if (typeof value !== 'string' || value.trim() === '') return false;
    if (value.length > 200) return false;
    if (value.includes('..') || value.includes('//') || value.includes(' ')) return false;
    var parts = value.split('/');
    if (parts.length < 1 || parts.length > 8) return false;
    for (var i = 0; i < parts.length; i += 1) {
      var seg = parts[i];
      if (seg.length === 0 || seg.length > 64) return false;
      if (!BRANCH_SEGMENT.test(seg)) return false;
    }
    return true;
  }

  function branchLabel(value) {
    if (typeof value !== 'string' || value.trim() === '') return NOT_AVAILABLE;
    var trimmed = value.trim();
    if (!branchNameOk(trimmed)) return NOT_AVAILABLE;
    return clipText(trimmed, TARGET_MAX);
  }

  function changedSummaryLabel(value) {
    if (typeof value === 'string') {
      var t = clipText(value.trim(), CHANGED_MAX).trim();
      return t === '' ? NOT_AVAILABLE : t;
    }
    if (Array.isArray(value)) {
      var parts = [];
      for (var i = 0; i < value.length && parts.length < 8; i += 1) {
        if (typeof value[i] === 'string' && value[i].trim() !== '') parts.push(clipText(value[i].trim(), 96));
      }
      return parts.length > 0 ? parts.join(', ') : NOT_AVAILABLE;
    }
    if (value && typeof value === 'object') {
      if (typeof value.summary === 'string') {
        var s = clipText(value.summary.trim(), CHANGED_MAX).trim();
        if (s !== '') return s;
      }
      if (typeof value.count === 'number' && Number.isInteger(value.count)) {
        return String(value.count) + ' files';
      }
    }
    return NOT_AVAILABLE;
  }

  function cleanStateLabel(value) {
    if (value === true) return 'clean';
    if (value === false) return 'dirty';
    if (value === 'clean') return 'clean';
    if (value === 'dirty') return 'dirty';
    return UNKNOWN;
  }

  function blockersLabel(value) {
    if (!Array.isArray(value) || value.length === 0) return 'None';
    var names = [];
    for (var i = 0; i < value.length && names.length < 8; i += 1) {
      if (typeof value[i] === 'string' && value[i].trim() !== '') names.push(clipText(value[i].trim(), 96));
      else if (value[i] && typeof value[i] === 'object' && typeof value[i].reason === 'string' && value[i].reason.trim() !== '') names.push(clipText(value[i].reason.trim(), 96));
    }
    return names.length > 0 ? names.join(', ') : 'None';
  }

  function pushStateLabel(value) {
    if (value === true) return 'pushed';
    if (value === false) return 'not pushed';
    if (typeof value === 'string' && value.trim() !== '') return clipText(value.trim(), 128);
    if (value && typeof value === 'object') {
      if (Array.isArray(value.branches) && value.branches.length > 0) {
        var b = [];
        for (var i = 0; i < value.branches.length && b.length < 4; i += 1) if (typeof value.branches[i] === 'string' && value.branches[i].trim() !== '') b.push(clipText(value.branches[i].trim(), 64));
        if (b.length > 0) return b.join(', ');
      }
      if (typeof value.pushed === 'boolean') return value.pushed ? 'pushed' : 'not pushed';
    }
    return NOT_AVAILABLE;
  }

  function draftPrLabel(value) {
    if (!value || typeof value !== 'object') {
      if (typeof value === 'string' && value.trim() !== '') return clipText(value.trim(), 128);
      return NOT_AVAILABLE;
    }
    if (typeof value.url === 'string' && value.url.trim() !== '') return clipText(value.url.trim(), 256);
    if (typeof value.number === 'number' && Number.isInteger(value.number)) return '#' + String(value.number);
    if (typeof value.head === 'string' && /^[a-fA-F0-9]{40}$/.test(value.head)) return value.head.toLowerCase();
    if (typeof value.ref === 'string' && value.ref.trim() !== '') return clipText(value.ref.trim(), 128);
    return NOT_AVAILABLE;
  }

  function usageLedgerLabel(value) {
    if (value == null) return UNKNOWN;
    if (typeof value === 'string') {
      var t = clipText(value.trim(), USAGE_MAX).trim();
      return t === '' ? UNKNOWN : t;
    }
    if (typeof value === 'object') {
      if (typeof value.summary === 'string') {
        var s = clipText(value.summary.trim(), USAGE_MAX).trim();
        if (s !== '') return s;
      }
      if (typeof value.compact === 'string') {
        var c = clipText(value.compact.trim(), USAGE_MAX).trim();
        if (c !== '') return c;
      }
      // Known compact shape: {tokens, cost} etc
      try {
        var json = JSON.stringify(value);
        if (json.length <= USAGE_MAX) return clipText(json, USAGE_MAX);
        return clipText(json.slice(0, USAGE_MAX), USAGE_MAX);
      } catch (e) { return UNKNOWN; }
    }
    return UNKNOWN;
  }

  function evidenceRefsLabel(value, fallbackKinds) {
    var list = null;
    if (Array.isArray(value) && value.length > 0) list = value;
    else if (Array.isArray(fallbackKinds) && fallbackKinds.length > 0) list = fallbackKinds;
    if (!list || list.length === 0) return NOT_AVAILABLE;
    var out = [];
    for (var i = 0; i < list.length && out.length < EVIDENCE_REF_MAX; i += 1) {
      var entry = list[i];
      var kind = null;
      if (typeof entry === 'string' && /^[a-z_]{3,32}$/.test(entry) && Object.prototype.hasOwnProperty.call(KNOWN_EVIDENCE_KINDS, entry)) kind = entry;
      else if (entry && typeof entry === 'object' && typeof entry.kind === 'string' && /^[a-z_]{3,32}$/.test(entry.kind) && Object.prototype.hasOwnProperty.call(KNOWN_EVIDENCE_KINDS, entry.kind)) kind = entry.kind;
      if (kind) out.push(kind);
    }
    return out.length > 0 ? out.join(', ') : NOT_AVAILABLE;
  }

  function solReadyLabel(experience) {
    var finalCard = experience && experience.final && typeof experience.final === 'object' ? experience.final : null;
    if (!finalCard) return 'no';
    var v = finalCard.ready_for_sol_merge;
    // Only strictly boolean true counts, and must be typed evidence: require evidence present true and candidate composed true if available
    if (v !== true) return 'no';
    var evidence = finalCard.evidence && typeof finalCard.evidence === 'object' ? finalCard.evidence : null;
    var candidate = finalCard.candidate && typeof finalCard.candidate === 'object' ? finalCard.candidate : null;
    // typed evidence requires evidence.present === true or evidence.digest valid; be strict but not fabricate
    if (!evidence || evidence.present !== true) return 'no';
    // If candidate exists, require composed true to avoid false ready
    if (candidate && candidate.composed !== true) return 'no';
    return 'yes';
  }

  function healthLabel(value) {
    if (value === true || value === 'healthy' || value === 'ok') return 'healthy';
    if (value === false || value === 'unhealthy' || value === 'failed') return 'unhealthy';
    if (typeof value === 'string' && value.trim() !== '') return clipText(value.trim(), 64);
    return NOT_AVAILABLE;
  }

  function pendingIdsLabel(value) {
    if (!Array.isArray(value) || value.length === 0) return 'None';
    var ids = [];
    for (var i = 0; i < value.length && ids.length < 8; i += 1) if (typeof value[i] === 'string' && value[i].trim() !== '') ids.push(clipText(value[i].trim(), 64));
    return ids.length > 0 ? ids.join(', ') : 'None';
  }

  function ownerOnlyKey(key) {
    return typeof key === 'string' && Object.prototype.hasOwnProperty.call(OWNER_ONLY_KEYS, key);
  }

  function stripOwnerOnly(value, depth) {
    if (value === undefined || value === null) return value;
    if (typeof value !== 'object') return value;
    if ((depth || 0) > 8) return null;
    if (Array.isArray(value)) {
      return value.slice(0, 8).map(function (entry) {
        return stripOwnerOnly(entry, (depth || 0) + 1);
      });
    }
    var copy = {};
    var keys = Object.keys(value);
    for (var i = 0; i < keys.length; i += 1) {
      var key = keys[i];
      if (ownerOnlyKey(key)) continue;
      copy[key] = stripOwnerOnly(value[key], (depth || 0) + 1);
    }
    return copy;
  }

  function isForbiddenHostMethod(method) {
    if (typeof method !== 'string' || method === '') return false;
    if (method === TOOL_CALL_METHOD) return true;
    if (method.indexOf('tools/') === 0) return true;
    if (method.indexOf('sampling/') === 0) return true;
    if (method.indexOf('completion/') === 0) return true;
    return /(?:^|\/)(?:dispatch|wait|reply|cleanup|merge|push|rebase|tag|release|create_pr|create-pr)(?:$|\/)/i.test(method);
  }

  function markupWithoutScripts(html) {
    var open = '<' + 'script';
    var close = '<' + '/script>';
    var source = String(html ?? '');
    var output = '';
    var cursor = 0;
    while (cursor < source.length) {
      var start = source.toLowerCase().indexOf(open, cursor);
      if (start === -1) {
        output += source.slice(cursor);
        break;
      }
      output += source.slice(cursor, start);
      var end = source.toLowerCase().indexOf(close, start);
      if (end === -1) break;
      cursor = end + close.length;
    }
    return output;
  }

  function documentContainsActionControls(html) {
    var markup = markupWithoutScripts(html);
    var controls = ['button', 'form', 'input', 'select', 'textarea'];
    for (var i = 0; i < controls.length; i += 1) {
      if (markup.toLowerCase().indexOf('<' + controls[i]) !== -1) return true;
    }
    if (/role\s*=\s*["']button["']/i.test(markup)) return true;
    if (new RegExp('<' + 'a\\b[^>]*href\\s*=', 'i').test(markup)) return true;
    if (/\bon(?:click|submit|keydown|load)\s*=/i.test(markup)) return true;
    return false;
  }

  function visiblePlainText(html) {
    return markupWithoutScripts(html)
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();
  }

  function joinIds(ids) {
    if (!Array.isArray(ids) || ids.length === 0) return NOT_AVAILABLE;
    var names = [];
    for (var i = 0; i < ids.length; i += 1) {
      if (typeof ids[i] === 'string' && ids[i].trim() !== '') names.push(clipText(ids[i], 96));
    }
    return names.length > 0 ? names.join(', ') : NOT_AVAILABLE;
  }

  function laneItems(lanes) {
    if (!Array.isArray(lanes)) return [];
    return lanes.slice(0, 8).filter(function (lane) {
      return lane && typeof lane === 'object';
    });
  }

  function renderLaneList(lanes) {
    var items = laneItems(lanes);
    if (items.length === 0) {
      return '<p class="cce-empty">' + escapeHtml(NOT_AVAILABLE) + '</p>';
    }
    var html = '<ul class="cce-lanes">';
    for (var i = 0; i < items.length; i += 1) {
      var lane = items[i];
      var scope = Array.isArray(lane.scope) && lane.scope.length > 0
        ? lane.scope.map(function (pattern) {
          return displayString(pattern, '');
        }).filter(Boolean).join(', ')
        : 'No write scope';
      html += '<li>';
      html += '<p><strong>' + escapeHtml(displayString(lane.assignment_id, 'unnamed assignment')) + '</strong></p>';
      html += '<p>' + escapeHtml(displayString(lane.provider_phrase, 'Provider not named')) + '</p>';
      html += '<p>Scope: ' + escapeHtml(scope) + '</p>';
      html += '<p>State: <span class="cce-mono">' + escapeHtml(displayString(lane.state, 'unknown')) + '</span></p>';
      html += '</li>';
    }
    html += '</ul>';
    return html;
  }

  function renderScopeList(scope) {
    if (!Array.isArray(scope) || scope.length === 0) {
      return '<p class="cce-empty">' + escapeHtml(NOT_AVAILABLE) + '</p>';
    }
    var html = '<ul class="cce-scope">';
    for (var i = 0; i < scope.slice(0, 8).length; i += 1) {
      var entry = scope[i];
      if (!entry || typeof entry !== 'object') continue;
      var patterns = Array.isArray(entry.scope) && entry.scope.length > 0
        ? entry.scope.map(function (pattern) { return displayString(pattern, ''); }).filter(Boolean).join(', ')
        : 'No write scope';
      html += '<li><p><strong>' + escapeHtml(displayString(entry.assignment_id, 'unnamed assignment')) + '</strong></p>';
      html += '<p>Role: ' + escapeHtml(displayString(entry.role, NOT_AVAILABLE)) + '</p>';
      html += '<p>Scope: ' + escapeHtml(patterns) + '</p></li>';
    }
    html += '</ul>';
    return html;
  }

  function presenceLine(record, emptyLabel) {
    if (!record || typeof record !== 'object') return NOT_AVAILABLE;
    if (record.present === true) return joinIds(record.lanes);
    return emptyLabel || 'None';
  }

  function renderRunCardHtml(experience) {
    var run = experience && experience.run && typeof experience.run === 'object' ? experience.run : {};
    var repository = run.repository && typeof run.repository === 'object' ? run.repository : {};
    var runningInfo = run.running && typeof run.running === 'object' ? run.running : {};
    var phrases = experience && experience.summary && Array.isArray(experience.summary.phrases)
      ? experience.summary.phrases
      : [];
    var phrase = typeof experience?.summary?.delegating === 'string'
      ? experience.summary.delegating
      : (phrases[0] || 'I am delegating this to Co-Engineer');
    var running = typeof experience?.summary?.reconciling === 'string'
      ? experience.summary.reconciling
      : (typeof experience?.summary?.running === 'string' ? experience.summary.running : '');
    var baseSha = sha40(repository.base_sha);
    var digest = digestValue(repository.digest);
    var runningProvider = displayString(runningInfo.provider_phrase || runningInfo.provider, NOT_AVAILABLE);
    var runningBranch = branchLabel(runningInfo.branch);
    var runningHead = sha40(runningInfo.head) || NOT_AVAILABLE;
    var runningHealth = typeof runningInfo.health === 'string' ? clipText(runningInfo.health, 64) : (runningInfo.health == null ? NOT_AVAILABLE : NOT_AVAILABLE);
    if (runningHealth === '') runningHealth = NOT_AVAILABLE;
    var runningPending = pendingIdsLabel(runningInfo.pending_ids);
    return [
      '<main>',
      '<article class="cce-card cce-card-run" data-cce-card="run" data-cce-display-only="true" aria-labelledby="cce-run-title">',
      '<header>',
      '<h1 id="cce-run-title">Co-Engineer run</h1>',
      '<p class="cce-phrase">' + escapeHtml(joinRunPhrases(phrase, running)) + '</p>',
      '<p class="cce-authority">' + escapeHtml(CODEX_AUTHORITY_SENTENCE) + '</p>',
      '</header>',
      '<section aria-labelledby="cce-objective-heading">',
      '<h2 id="cce-objective-heading">Objective</h2>',
      '<p data-field="objective">' + escapeHtml(displayString(run.objective)) + '</p>',
      '</section>',
      '<section aria-labelledby="cce-repo-heading">',
      '<h2 id="cce-repo-heading">Repository</h2>',
      '<dl>',
      '<div><dt>Base SHA</dt><dd data-field="base_sha">' + escapeHtml(baseSha || NOT_AVAILABLE) + '</dd></div>',
      '<div><dt>Digest</dt><dd data-field="digest">' + escapeHtml(digest || NOT_AVAILABLE) + '</dd></div>',
      '</dl>',
      '</section>',
      '<section aria-labelledby="cce-lanes-heading">',
      '<h2 id="cce-lanes-heading">Assignments</h2>',
      renderLaneList(run.lanes),
      '</section>',
      '<section aria-labelledby="cce-running-heading">',
      '<h2 id="cce-running-heading">Running</h2>',
      '<dl>',
      '<div><dt>Provider</dt><dd data-field="running_provider">' + escapeHtml(runningProvider) + '</dd></div>',
      '<div><dt>Branch</dt><dd data-field="running_branch">' + escapeHtml(runningBranch) + '</dd></div>',
      '<div><dt>Head</dt><dd data-field="running_head">' + escapeHtml(runningHead) + '</dd></div>',
      '<div><dt>Health</dt><dd data-field="running_health">' + escapeHtml(runningHealth) + '</dd></div>',
      '<div><dt>Pending IDs</dt><dd data-field="running_pending">' + escapeHtml(runningPending) + '</dd></div>',
      '</dl>',
      '<p class="cce-note">Efficiency: provider, branch, head, health, and pending IDs without routine wake.</p>',
      '</section>',
      '<p class="cce-note">' + escapeHtml(DISPLAY_ONLY_NOTE) + '</p>',
      '</article>',
      '</main>',
    ].join('');
  }

  function boolLabel(value) {
    return value === true ? 'yes' : 'no';
  }

  function consentRecord(experience) {
    var attention = experience && experience.attention && typeof experience.attention === 'object'
      ? experience.attention
      : null;
    var consent = attention && attention.consent && typeof attention.consent === 'object'
      ? attention.consent
      : null;
    var request = consent && consent.request && typeof consent.request === 'object'
      ? consent.request
      : {};
    if (!consent) return null;
    return { consent: consent, request: request };
  }

  function consentProviderLine(providers) {
    if (!Array.isArray(providers) || providers.length === 0) return NOT_AVAILABLE;
    return providers.slice(0, 8).map(function (provider) {
      return displayString(provider, 'Provider not named');
    }).join(', ');
  }

  function renderConsentCardHtml(experience) {
    var entry = consentRecord(experience) || { consent: {}, request: {} };
    var consent = entry.consent;
    var request = entry.request;
    var status = displayString(consent.status, 'required');
    var pending = status === 'pending' || status === 'required';
    var message = pending ? CONSENT_MESSAGE : 'The host did not approve repository exposure for this run.';
    return [
      '<main>',
      '<article class="cce-card cce-card-consent" data-cce-card="attention" data-cce-display-only="true" aria-labelledby="cce-consent-title">',
      '<header>',
      '<h1 id="cce-consent-title">Co-Engineer repository access</h1>',
      '<p class="cce-phrase">Co-Engineer needs one decision from you</p>',
      '<p class="cce-authority">' + escapeHtml(CODEX_AUTHORITY_SENTENCE) + '</p>',
      '</header>',
      '<section aria-labelledby="cce-consent-request-heading">',
      '<h2 id="cce-consent-request-heading">Host-owned decision</h2>',
      '<p data-field="consent_message">' + escapeHtml(message) + '</p>',
      '<dl>',
      '<div><dt>Status</dt><dd data-field="consent_status">' + escapeHtml(status) + '</dd></div>',
      '<div><dt>Providers</dt><dd data-field="consent_providers">' + escapeHtml(consentProviderLine(request.provider_phrases || request.providers)) + '</dd></div>',
      '<div><dt>Scope</dt><dd data-field="consent_scope">' + escapeHtml(displayString(request.scope)) + '</dd></div>',
      '<div><dt>Duration</dt><dd data-field="consent_duration">' + escapeHtml(displayString(request.duration)) + '</dd></div>',
      '<div><dt>Remote mutation</dt><dd data-field="consent_remote_mutation">' + escapeHtml(request.remote_mutation === false ? 'no' : NOT_AVAILABLE) + '</dd></div>',
      '<div><dt>Repository identity</dt><dd data-field="consent_repository_identity">' + escapeHtml(displayString(request.repository_identity)) + '</dd></div>',
      '</dl>',
      '</section>',
      '<p class="cce-note">Review this request in the host. This display-only card cannot send a model reply or approve repository exposure.</p>',
      '</article>',
      '</main>',
    ].join('');
  }

  function renderFinalCardHtml(experience) {
    var finalCard = experience && experience.final && typeof experience.final === 'object' ? experience.final : {};
    var git = finalCard.git && typeof finalCard.git === 'object' ? finalCard.git : {};
    var candidate = finalCard.candidate && typeof finalCard.candidate === 'object' ? finalCard.candidate : {};
    var evidence = finalCard.evidence && typeof finalCard.evidence === 'object' ? finalCard.evidence : {};
    var pr = finalCard.pr_ready && typeof finalCard.pr_ready === 'object' ? finalCard.pr_ready : {};
    // Back-compat fallbacks for direct pr fields
    var ownedBranch = branchLabel(pr.owned_branch != null ? pr.owned_branch : git.branch);
    var targetBranch = branchLabel(pr.target != null ? pr.target : git.target);
    var changedSummary = typeof pr.changed_summary === 'string' ? clipText(pr.changed_summary, CHANGED_MAX) : (typeof finalCard.changed_summary === 'string' ? clipText(finalCard.changed_summary, CHANGED_MAX) : NOT_AVAILABLE);
    if (!changedSummary || changedSummary.trim() === '') changedSummary = NOT_AVAILABLE;
    var cleanState = cleanStateLabel(pr.clean_state != null ? pr.clean_state : finalCard.clean_state);
    var verification = pr.verification && typeof pr.verification === 'object' ? pr.verification : {};
    var blockers = blockersLabel(verification.blockers);
    var verificationLine = verification.present === true ? 'present' : (verification.present === false ? 'absent' : NOT_AVAILABLE);
    if (Array.isArray(verification.tests) && verification.tests.length > 0) verificationLine += ', tests: ' + joinIds(verification.tests);
    else if (verification.tests_present === true) verificationLine += ', tests present';
    if (verification.tests_passed === true) verificationLine += ' (passed)';
    var pushState = typeof pr.push_state === 'string' ? clipText(pr.push_state, 128) : pushStateLabel(pr.push_state);
    if (!pushState || pushState.trim() === '') pushState = NOT_AVAILABLE;
    var draftPr = typeof pr.draft_pr === 'string' ? clipText(pr.draft_pr, 256) : draftPrLabel(pr.draft_pr);
    if (!draftPr || draftPr.trim() === '') draftPr = NOT_AVAILABLE;
    var currentPrHead = sha40(pr.current_pr_head != null ? pr.current_pr_head : finalCard.current_pr_head) || NOT_AVAILABLE;
    var solReady = solReadyLabel(experience);
    var usageLedger = typeof pr.usage_ledger_summary === 'string' ? clipText(pr.usage_ledger_summary, USAGE_MAX) : (typeof finalCard.usage_ledger_summary === 'string' ? clipText(finalCard.usage_ledger_summary, USAGE_MAX) : UNKNOWN);
    if (!usageLedger || usageLedger.trim() === '') usageLedger = UNKNOWN;
    var evidenceRefs = evidenceRefsLabel(pr.evidence_refs != null ? pr.evidence_refs : finalCard.evidence_refs, evidence.kinds);
    var verified = experience && experience.summary && typeof experience.summary.verified_final === 'string'
      ? experience.summary.verified_final
      : '';
    var kinds = Array.isArray(evidence.kinds) ? evidence.kinds.filter(function (kind) {
      return typeof kind === 'string' && Object.prototype.hasOwnProperty.call(KNOWN_EVIDENCE_KINDS, kind);
    }).slice(0, 16) : [];
    var allowedVerified = verified === VERIFIED_FINAL_SENTENCE
      && candidate.composed === true
      && candidate.ready_for_codex_review === true
      && candidate.accepted === true;
    var phraseHtml = allowedVerified
      ? '<p class="cce-phrase">' + escapeHtml(clipText(verified, QUESTION_MAX)) + '</p>'
      : '';
    return [
      '<main>',
      '<article class="cce-card cce-card-final" data-cce-card="final" data-cce-display-only="true" aria-labelledby="cce-final-title">',
      '<header>',
      '<h1 id="cce-final-title">Co-Engineer final decision</h1>',
      phraseHtml,
      '<p class="cce-authority">' + escapeHtml(CODEX_AUTHORITY_SENTENCE) + '</p>',
      '</header>',
      '<section aria-labelledby="cce-outcomes-heading">',
      '<h2 id="cce-outcomes-heading">Lane outcomes</h2>',
      '<dl>',
      '<div><dt>Accepted</dt><dd data-field="accepted_lanes">' + escapeHtml(joinIds(finalCard.accepted_lanes)) + '</dd></div>',
      '<div><dt>Failed</dt><dd data-field="failed_lanes">' + escapeHtml(joinIds(finalCard.failed_lanes)) + '</dd></div>',
      '<div><dt>Unresolved</dt><dd data-field="unresolved_lanes">' + escapeHtml(joinIds(finalCard.unresolved_lanes)) + '</dd></div>',
      '</dl>',
      '</section>',
      '<section aria-labelledby="cce-git-heading">',
      '<h2 id="cce-git-heading">Git identity</h2>',
      '<dl>',
      '<div><dt>Branch</dt><dd data-field="branch">' + escapeHtml(ownedBranch) + '</dd></div>',
      '<div><dt>Head</dt><dd data-field="head">' + escapeHtml(sha40(git.head) || NOT_AVAILABLE) + '</dd></div>',
      '<div><dt>Tree</dt><dd data-field="tree">' + escapeHtml(sha40(git.tree) || NOT_AVAILABLE) + '</dd></div>',
      '<div><dt>Base SHA</dt><dd data-field="base_sha">' + escapeHtml(sha40(git.base_sha) || NOT_AVAILABLE) + '</dd></div>',
      '<div><dt>Target</dt><dd data-field="target">' + escapeHtml(targetBranch) + '</dd></div>',
      '</dl>',
      '</section>',
      '<section aria-labelledby="cce-changed-heading">',
      '<h2 id="cce-changed-heading">Changed</h2>',
      '<p data-field="changed_summary">' + escapeHtml(changedSummary) + '</p>',
      '</section>',
      '<section aria-labelledby="cce-clean-heading">',
      '<h2 id="cce-clean-heading">Clean state</h2>',
      '<p data-field="clean_state">' + escapeHtml(cleanState) + '</p>',
      '</section>',
      '<section aria-labelledby="cce-verification-heading">',
      '<h2 id="cce-verification-heading">Verification</h2>',
      '<p data-field="verification">' + escapeHtml(verificationLine) + '</p>',
      '<p data-field="blockers">Blockers: ' + escapeHtml(blockers) + '</p>',
      '</section>',
      '<section aria-labelledby="cce-push-heading">',
      '<h2 id="cce-push-heading">Push / PR</h2>',
      '<dl>',
      '<div><dt>Push</dt><dd data-field="push_state">' + escapeHtml(pushState) + '</dd></div>',
      '<div><dt>Draft PR</dt><dd data-field="draft_pr">' + escapeHtml(draftPr) + '</dd></div>',
      '<div><dt>Current PR Head</dt><dd data-field="current_pr_head">' + escapeHtml(currentPrHead) + '</dd></div>',
      '</dl>',
      '</section>',
      '<section aria-labelledby="cce-sol-heading">',
      '<h2 id="cce-sol-heading">Ready for Sol merge</h2>',
      '<p data-field="ready_for_sol_merge">' + escapeHtml(solReady) + '</p>',
      '</section>',
      '<section aria-labelledby="cce-scope-heading">',
      '<h2 id="cce-scope-heading">Scope</h2>',
      renderScopeList(finalCard.scope),
      '</section>',
      '<section aria-labelledby="cce-tests-heading">',
      '<h2 id="cce-tests-heading">Tests</h2>',
      '<p data-field="tests">' + escapeHtml(presenceLine(finalCard.tests, 'No test lanes')) + '</p>',
      '</section>',
      '<section aria-labelledby="cce-reviews-heading">',
      '<h2 id="cce-reviews-heading">Reviews</h2>',
      '<p data-field="reviews">' + escapeHtml(presenceLine(finalCard.reviews, 'No review lanes')) + '</p>',
      '</section>',
      '<section aria-labelledby="cce-candidate-heading">',
      '<h2 id="cce-candidate-heading">Candidate</h2>',
      '<dl>',
      '<div><dt>Ref</dt><dd>' + escapeHtml(displayString(candidate.ref)) + '</dd></div>',
      '<div><dt>Composed</dt><dd>' + escapeHtml(boolLabel(candidate.composed === true)) + '</dd></div>',
      '<div><dt>Ready for Codex review</dt><dd>' + escapeHtml(boolLabel(candidate.ready_for_codex_review === true)) + '</dd></div>',
      '<div><dt>Accepted</dt><dd>' + escapeHtml(boolLabel(candidate.accepted === true)) + '</dd></div>',
      '</dl>',
      '</section>',
      '<section aria-labelledby="cce-usage-heading">',
      '<h2 id="cce-usage-heading">Usage</h2>',
      '<p data-field="usage_ledger_summary">' + escapeHtml(usageLedger) + '</p>',
      '</section>',
      '<section aria-labelledby="cce-evidence-heading">',
      '<h2 id="cce-evidence-heading">Evidence</h2>',
      '<dl>',
      '<div><dt>Present</dt><dd>' + escapeHtml(boolLabel(evidence.present === true)) + '</dd></div>',
      '<div><dt>Digest</dt><dd>' + escapeHtml(digestValue(evidence.digest) || NOT_AVAILABLE) + '</dd></div>',
      '<div><dt>Facts</dt><dd>' + escapeHtml(String(Number.isInteger(evidence.fact_count) ? evidence.fact_count : 0)) + '</dd></div>',
      '<div><dt>Claims</dt><dd>' + escapeHtml(String(Number.isInteger(evidence.claim_count) ? evidence.claim_count : 0)) + '</dd></div>',
      '<div><dt>Kinds</dt><dd>' + escapeHtml(kinds.length > 0 ? kinds.join(', ') : NOT_AVAILABLE) + '</dd></div>',
      '<div><dt>Refs</dt><dd data-field="evidence_refs">' + escapeHtml(evidenceRefs) + '</dd></div>',
      '</dl>',
      '</section>',
      '<p class="cce-note">' + escapeHtml(DISPLAY_ONLY_NOTE) + '</p>',
      '</article>',
      '</main>',
    ].join('');
  }

  function renderInlineCardHtml(card, experience) {
    var safe = stripOwnerOnly(experience) || {};
    if (card === 'run') return renderRunCardHtml(safe);
    if (card === 'attention' && consentRecord(safe)) return renderConsentCardHtml(safe);
    if (card === 'final') return renderFinalCardHtml(safe);
    return '';
  }

  function unwrapExperience(data) {
    if (!data || typeof data !== 'object') return null;
    if (data.experience && typeof data.experience === 'object') return stripOwnerOnly(data.experience);
    var params = data.params && typeof data.params === 'object' ? data.params : null;
    var result = params && params.result && typeof params.result === 'object' ? params.result : params;
    var resultMeta = result && result._meta && typeof result._meta === 'object'
      ? result._meta
      : (params && params._meta && typeof params._meta === 'object'
        ? params._meta
        : (data._meta && typeof data._meta === 'object' ? data._meta : null));
    var metaExperience = resultMeta && resultMeta['codex-co-engineer/experience'];
    if (metaExperience && typeof metaExperience === 'object') {
      return stripOwnerOnly(metaExperience);
    }
    var structured = result && result.structuredContent && typeof result.structuredContent === 'object'
      ? result.structuredContent
      : (data.structuredContent && typeof data.structuredContent === 'object' ? data.structuredContent : null);
    if (structured && structured.experience && typeof structured.experience === 'object') {
      return stripOwnerOnly(structured.experience);
    }
    if (structured && typeof structured.card === 'string') return stripOwnerOnly(structured);
    if (typeof data.card === 'string') return stripOwnerOnly(data);
    return null;
  }

  function fieldMap(card, experience) {
    var safe = stripOwnerOnly(experience) || {};
    if (card === 'run') {
      var run = safe.run && typeof safe.run === 'object' ? safe.run : {};
      var repository = run.repository && typeof run.repository === 'object' ? run.repository : {};
      var runningInfo = run.running && typeof run.running === 'object' ? run.running : {};
      var phrases = safe.summary && Array.isArray(safe.summary.phrases) ? safe.summary.phrases : [];
      var phrase = typeof safe.summary?.delegating === 'string'
        ? safe.summary.delegating
        : (phrases[0] || 'I am delegating this to Co-Engineer');
      var running = typeof safe.summary?.reconciling === 'string'
        ? safe.summary.reconciling
        : (typeof safe.summary?.running === 'string' ? safe.summary.running : '');
      return {
        phrase: joinRunPhrases(phrase, running),
        objective: displayString(run.objective),
        base_sha: sha40(repository.base_sha) || NOT_AVAILABLE,
        digest: digestValue(repository.digest) || NOT_AVAILABLE,
        lanes: laneItems(run.lanes),
        running_provider: displayString(runningInfo.provider_phrase || runningInfo.provider, NOT_AVAILABLE),
        running_branch: branchLabel(runningInfo.branch),
        running_head: sha40(runningInfo.head) || NOT_AVAILABLE,
        running_health: typeof runningInfo.health === 'string' && runningInfo.health.trim() !== '' ? clipText(runningInfo.health.trim(), 64) : NOT_AVAILABLE,
        running_pending: pendingIdsLabel(runningInfo.pending_ids),
      };
    }
    if (card === 'final') {
      var finalCard = safe.final && typeof safe.final === 'object' ? safe.final : {};
      var git = finalCard.git && typeof finalCard.git === 'object' ? finalCard.git : {};
      var pr = finalCard.pr_ready && typeof finalCard.pr_ready === 'object' ? finalCard.pr_ready : {};
      var candidate = finalCard.candidate && typeof finalCard.candidate === 'object' ? finalCard.candidate : {};
      var evidence = finalCard.evidence && typeof finalCard.evidence === 'object' ? finalCard.evidence : {};
      var kinds = Array.isArray(evidence.kinds) ? evidence.kinds.filter(function (kind) {
        return typeof kind === 'string' && Object.prototype.hasOwnProperty.call(KNOWN_EVIDENCE_KINDS, kind);
      }).slice(0, 16) : [];
      var verified = typeof safe.summary?.verified_final === 'string' ? safe.summary.verified_final : '';
      var allowedVerified = verified === VERIFIED_FINAL_SENTENCE
        && candidate.composed === true
        && candidate.ready_for_codex_review === true
        && candidate.accepted === true;
      var verif = pr.verification && typeof pr.verification === 'object' ? pr.verification : {};
      return {
        verified_final: allowedVerified ? clipText(verified, QUESTION_MAX) : '',
        accepted_lanes: joinIds(finalCard.accepted_lanes),
        failed_lanes: joinIds(finalCard.failed_lanes),
        unresolved_lanes: joinIds(finalCard.unresolved_lanes),
        branch: branchLabel(pr.owned_branch != null ? pr.owned_branch : git.branch),
        head: sha40(git.head) || NOT_AVAILABLE,
        tree: sha40(git.tree) || NOT_AVAILABLE,
        base_sha: sha40(git.base_sha) || NOT_AVAILABLE,
        target: branchLabel(pr.target != null ? pr.target : git.target),
        changed_summary: typeof pr.changed_summary === 'string' && pr.changed_summary.trim() !== '' ? clipText(pr.changed_summary.trim(), CHANGED_MAX) : (typeof finalCard.changed_summary === 'string' && finalCard.changed_summary.trim() !== '' ? clipText(finalCard.changed_summary.trim(), CHANGED_MAX) : NOT_AVAILABLE),
        clean_state: cleanStateLabel(pr.clean_state != null ? pr.clean_state : finalCard.clean_state),
        verification: (function(){
          var blockers = blockersLabel(verif.blockers);
          var line = verif.present === true ? 'present' : (verif.present === false ? 'absent' : NOT_AVAILABLE);
          if (Array.isArray(verif.tests) && verif.tests.length > 0) line += ', tests: ' + joinIds(verif.tests);
          else if (verif.tests_present === true) line += ', tests present';
          if (verif.tests_passed === true) line += ' (passed)';
          return line + '; Blockers: ' + blockers;
        })(),
        blockers: blockersLabel(verif.blockers),
        push_state: typeof pr.push_state === 'string' && pr.push_state.trim() !== '' ? clipText(pr.push_state.trim(), 128) : pushStateLabel(pr.push_state),
        draft_pr: typeof pr.draft_pr === 'string' && pr.draft_pr.trim() !== '' ? clipText(pr.draft_pr.trim(), 256) : draftPrLabel(pr.draft_pr),
        current_pr_head: sha40(pr.current_pr_head != null ? pr.current_pr_head : finalCard.current_pr_head) || NOT_AVAILABLE,
        ready_for_sol_merge: solReadyLabel(safe),
        scope: Array.isArray(finalCard.scope) ? finalCard.scope.slice(0, 8) : [],
        tests: presenceLine(finalCard.tests, 'No test lanes'),
        reviews: presenceLine(finalCard.reviews, 'No review lanes'),
        candidate_ref: displayString(candidate.ref),
        candidate_composed: boolLabel(candidate.composed === true),
        candidate_ready: boolLabel(candidate.ready_for_codex_review === true),
        candidate_accepted: boolLabel(candidate.accepted === true),
        evidence_present: boolLabel(evidence.present === true),
        evidence_digest: digestValue(evidence.digest) || NOT_AVAILABLE,
        evidence_facts: String(Number.isInteger(evidence.fact_count) ? evidence.fact_count : 0),
        evidence_claims: String(Number.isInteger(evidence.claim_count) ? evidence.claim_count : 0),
        evidence_kinds: kinds.length > 0 ? kinds.join(', ') : NOT_AVAILABLE,
        evidence_refs: evidenceRefsLabel(pr.evidence_refs != null ? pr.evidence_refs : finalCard.evidence_refs, evidence.kinds),
        usage_ledger_summary: (function(){
          var v = pr.usage_ledger_summary != null ? pr.usage_ledger_summary : finalCard.usage_ledger_summary;
          if (typeof v === 'string' && v.trim() !== '') return clipText(v.trim(), USAGE_MAX);
          if (v == null) return UNKNOWN;
          return clipText(String(v), USAGE_MAX);
        })(),
      };
    }
    if (card === 'attention' && consentRecord(safe)) {
      var consentEntry = consentRecord(safe);
      var consent = consentEntry.consent;
      var consentRequest = consentEntry.request;
      return {
        consent_message: consent.status === 'pending' || consent.status === 'required'
          ? CONSENT_MESSAGE
          : 'The host did not approve repository exposure for this run.',
        consent_status: displayString(consent.status, 'required'),
        consent_providers: consentProviderLine(consentRequest.provider_phrases || consentRequest.providers),
        consent_scope: displayString(consentRequest.scope),
        consent_duration: displayString(consentRequest.duration),
        consent_remote_mutation: consentRequest.remote_mutation === false ? 'no' : NOT_AVAILABLE,
        consent_repository_identity: displayString(consentRequest.repository_identity),
      };
    }
    return {};
  }

  function setTextContent(node, value) {
    if (!node) return;
    node.textContent = value == null || value === '' ? NOT_AVAILABLE : String(value);
    if (Object.prototype.hasOwnProperty.call(node, 'hidden') || node.hidden === true || node.hidden === false) {
      if (value === '' && node.getAttribute && node.getAttribute('data-field') === 'verified_final') {
        node.hidden = true;
      } else if (node.getAttribute && node.getAttribute('data-field') === 'verified_final') {
        node.hidden = false;
      }
    }
  }

  function appendLane(documentRef, list, lane) {
    var li = documentRef.createElement('li');
    var title = documentRef.createElement('p');
    var strong = documentRef.createElement('strong');
    strong.textContent = displayString(lane.assignment_id, 'unnamed assignment');
    title.appendChild(strong);
    var provider = documentRef.createElement('p');
    provider.textContent = displayString(lane.provider_phrase, 'Provider not named');
    var scope = documentRef.createElement('p');
    var scopeText = Array.isArray(lane.scope) && lane.scope.length > 0
      ? lane.scope.map(function (pattern) { return displayString(pattern, ''); }).filter(Boolean).join(', ')
      : 'No write scope';
    scope.textContent = 'Scope: ' + scopeText;
    var state = documentRef.createElement('p');
    var stateValue = documentRef.createElement('span');
    stateValue.className = 'cce-mono';
    stateValue.textContent = displayString(lane.state, 'unknown');
    state.appendChild(documentRef.createTextNode('State: '));
    state.appendChild(stateValue);
    li.appendChild(title);
    li.appendChild(provider);
    li.appendChild(scope);
    li.appendChild(state);
    list.appendChild(li);
  }

  function appendScope(documentRef, list, entry) {
    var li = documentRef.createElement('li');
    var title = documentRef.createElement('p');
    var strong = documentRef.createElement('strong');
    strong.textContent = displayString(entry && entry.assignment_id, 'unnamed assignment');
    title.appendChild(strong);
    var role = documentRef.createElement('p');
    role.textContent = 'Role: ' + displayString(entry && entry.role, NOT_AVAILABLE);
    var scope = documentRef.createElement('p');
    var patterns = Array.isArray(entry && entry.scope) && entry.scope.length > 0
      ? entry.scope.map(function (pattern) { return displayString(pattern, ''); }).filter(Boolean).join(', ')
      : 'No write scope';
    scope.textContent = 'Scope: ' + patterns;
    li.appendChild(title);
    li.appendChild(role);
    li.appendChild(scope);
    list.appendChild(li);
  }

  function paintDom(documentRef, root, card, experience) {
    if (!root || !documentRef || typeof root.querySelector !== 'function') return;
    var fields = fieldMap(card, experience);
    var keys = Object.keys(fields);
    for (var i = 0; i < keys.length; i += 1) {
      var key = keys[i];
      var node = root.querySelector('[data-field="' + key + '"]');
      if (!node) continue;
      if (key === 'lanes') {
        while (node.firstChild) node.removeChild(node.firstChild);
        var lanes = fields.lanes;
        if (!lanes || lanes.length === 0) {
          var emptyLane = documentRef.createElement('li');
          emptyLane.className = 'cce-empty';
          emptyLane.textContent = NOT_AVAILABLE;
          node.appendChild(emptyLane);
        } else {
          for (var laneIndex = 0; laneIndex < lanes.length; laneIndex += 1) {
            appendLane(documentRef, node, lanes[laneIndex]);
          }
        }
        continue;
      }
      if (key === 'scope') {
        while (node.firstChild) node.removeChild(node.firstChild);
        var scope = fields.scope;
        if (!scope || scope.length === 0) {
          var emptyScope = documentRef.createElement('li');
          emptyScope.className = 'cce-empty';
          emptyScope.textContent = NOT_AVAILABLE;
          node.appendChild(emptyScope);
        } else {
          for (var scopeIndex = 0; scopeIndex < scope.length; scopeIndex += 1) {
            appendScope(documentRef, node, scope[scopeIndex]);
          }
        }
        continue;
      }
      if (key === 'verified_final') {
        if (!fields.verified_final) {
          node.hidden = true;
          node.textContent = NOT_AVAILABLE;
        } else {
          node.hidden = false;
          node.textContent = fields.verified_final;
        }
        continue;
      }
      setTextContent(node, fields[key]);
    }
  }

  function parseHostContext(data) {
    if (!data || typeof data !== 'object') return null;
    var source = data.params && typeof data.params === 'object' ? data.params : data;
    if (source.hostContext && typeof source.hostContext === 'object') source = source.hostContext;
    if (source.result && source.result.hostContext && typeof source.result.hostContext === 'object') {
      source = source.result.hostContext;
    }
    var theme = typeof source.theme === 'string' ? source.theme : null;
    var locale = typeof source.locale === 'string'
      ? source.locale
      : (Array.isArray(source.locales) && typeof source.locales[0] === 'string' ? source.locales[0] : null);
    var dir = typeof source.dir === 'string'
      ? source.dir
      : (typeof source.direction === 'string' ? source.direction : null);
    if (!theme && !locale && !dir) return null;
    return { theme: theme, locale: locale, dir: dir };
  }

  function applyHostContext(documentRef, context) {
    if (!documentRef || !documentRef.documentElement || !context) return false;
    var html = documentRef.documentElement;
    if (context.theme === 'dark' || context.theme === 'light') {
      html.setAttribute('data-cce-theme', context.theme);
    }
    if (typeof context.locale === 'string' && context.locale !== '') {
      var lang = context.locale.replace(/_/g, '-');
      html.setAttribute('lang', lang);
      if (!context.dir && /^(ar|he|fa|ur)(?:-|$)/i.test(lang)) {
        html.setAttribute('dir', 'rtl');
      }
    }
    if (context.dir === 'rtl' || context.dir === 'ltr' || context.dir === 'auto') {
      html.setAttribute('dir', context.dir);
    }
    return true;
  }

  function createDisplayOnlySession(options) {
    var opts = options && typeof options === 'object' ? options : {};
    var card = INLINE_CARDS[opts.card] ? opts.card : null;
    var outbound = [];
    var rejected = [];
    var painted = [];

    function send(message) {
      var method = message && typeof message.method === 'string' ? message.method : null;
      if (method && isForbiddenHostMethod(method)) {
        rejected.push(method);
        return false;
      }
      if (method && method.indexOf('ui/') !== 0) {
        rejected.push(method);
        return false;
      }
      outbound.push(message);
      if (typeof opts.postMessage === 'function') opts.postMessage(message);
      return true;
    }

    function paint(experience) {
      var safe = stripOwnerOnly(experience);
      if (!safe || safe.card !== card) return false;
      if (card === 'attention' && !consentRecord(safe)) return false;
      painted.push(safe.card);
      if (typeof opts.applyHtml === 'function') opts.applyHtml(renderInlineCardHtml(card, safe));
      if (opts.root && opts.document) paintDom(opts.document, opts.root, card, safe);
      return true;
    }

    function handleMessage(data) {
      if (!data || typeof data !== 'object') return;
      var inboundMethod = typeof data.method === 'string' ? data.method : null;
      var hostContext = parseHostContext(data);
      if (hostContext && opts.document) applyHostContext(opts.document, hostContext);
      if (inboundMethod === 'ui/notifications/host-context-changed') return;
      if (inboundMethod && (isForbiddenHostMethod(inboundMethod) || inboundMethod.indexOf('ui/') !== 0)) {
        rejected.push(inboundMethod);
        return;
      }
      if (Object.prototype.hasOwnProperty.call(data, 'id') && data.method === 'ui/initialize') {
        send({
          jsonrpc: '2.0',
          id: data.id,
          result: {
            protocolVersion: '2025-11-25',
            capabilities: {},
            appInfo: {
              name: 'codex-co-engineer-experience-' + (card || 'card'),
              version: '1',
            },
          },
        });
        return;
      }
      var experience = unwrapExperience(data);
      if (experience) paint(experience);
    }

    function start() {
      send({
        jsonrpc: '2.0',
        id: 'cce-ui-init',
        method: 'ui/initialize',
        params: { protocolVersion: '2025-11-25' },
      });
    }

    return Object.freeze({
      card: card,
      handleMessage: handleMessage,
      paint: paint,
      start: start,
      outbound: outbound,
      rejected: rejected,
      painted: painted,
    });
  }

  function connectDisplayOnlyCard(target, options) {
    var documentRef = target || global.document;
    if (!documentRef || typeof documentRef.querySelector !== 'function') return null;
    var root = documentRef.querySelector('[data-cce-card]');
    if (!root) return null;
    var session = createDisplayOnlySession({
      card: root.getAttribute('data-cce-card'),
      document: documentRef,
      root: root,
      postMessage: function (message) {
        var dest = (options && options.parent) || global.parent;
        if (dest && dest !== global && typeof dest.postMessage === 'function') {
          dest.postMessage(message, (options && options.targetOrigin) || '*');
        }
      },
    });
    if (typeof global.addEventListener === 'function') {
      global.addEventListener('message', function (event) {
        if (event && global.parent && event.source && event.source !== global.parent) return;
        session.handleMessage(event && event.data);
      });
    }
    session.start();
    return session;
  }

  var api = Object.freeze({
    CODEX_AUTHORITY_SENTENCE: CODEX_AUTHORITY_SENTENCE,
    DISPLAY_ONLY_NOTE: DISPLAY_ONLY_NOTE,
    NOT_AVAILABLE: NOT_AVAILABLE,
    TOOL_CALL_METHOD: TOOL_CALL_METHOD,
    applyHostContext: applyHostContext,
    clipText: clipText,
    connectDisplayOnlyCard: connectDisplayOnlyCard,
    createDisplayOnlySession: createDisplayOnlySession,
    displayString: displayString,
    documentContainsActionControls: documentContainsActionControls,
    escapeHtml: escapeHtml,
    fieldMap: fieldMap,
    isForbiddenHostMethod: isForbiddenHostMethod,
    joinIds: joinIds,
    markupWithoutScripts: markupWithoutScripts,
    parseHostContext: parseHostContext,
    redactDisplay: redactDisplay,
    renderFinalCardHtml: renderFinalCardHtml,
    renderInlineCardHtml: renderInlineCardHtml,
    renderConsentCardHtml: renderConsentCardHtml,
    renderRunCardHtml: renderRunCardHtml,
    stripOwnerOnly: stripOwnerOnly,
    unwrapExperience: unwrapExperience,
    visiblePlainText: visiblePlainText,
  });

  global.CodexCoEngineerExperienceUi = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
