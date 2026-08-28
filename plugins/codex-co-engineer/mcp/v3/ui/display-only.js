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
  };
  var INLINE_CARDS = { run: true, final: true };
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
  var OBJECTIVE_MAX = 512;
  var QUESTION_MAX = 320;

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
    var phrases = experience && experience.summary && Array.isArray(experience.summary.phrases)
      ? experience.summary.phrases
      : [];
    var phrase = typeof experience?.summary?.delegating === 'string'
      ? experience.summary.delegating
      : (phrases[0] || 'I am delegating this to Co-Engineer');
    var running = typeof experience?.summary?.running === 'string' ? experience.summary.running : '';
    var baseSha = sha40(repository.base_sha);
    var digest = digestValue(repository.digest);
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
      '<p class="cce-note">' + escapeHtml(DISPLAY_ONLY_NOTE) + '</p>',
      '</article>',
      '</main>',
    ].join('');
  }

  function boolLabel(value) {
    return value === true ? 'yes' : 'no';
  }

  function renderFinalCardHtml(experience) {
    var finalCard = experience && experience.final && typeof experience.final === 'object' ? experience.final : {};
    var git = finalCard.git && typeof finalCard.git === 'object' ? finalCard.git : {};
    var candidate = finalCard.candidate && typeof finalCard.candidate === 'object' ? finalCard.candidate : {};
    var evidence = finalCard.evidence && typeof finalCard.evidence === 'object' ? finalCard.evidence : {};
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
      '<div><dt>Branch</dt><dd data-field="branch">' + escapeHtml(displayString(git.branch)) + '</dd></div>',
      '<div><dt>Head</dt><dd data-field="head">' + escapeHtml(sha40(git.head) || NOT_AVAILABLE) + '</dd></div>',
      '<div><dt>Tree</dt><dd data-field="tree">' + escapeHtml(sha40(git.tree) || NOT_AVAILABLE) + '</dd></div>',
      '</dl>',
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
      '<section aria-labelledby="cce-evidence-heading">',
      '<h2 id="cce-evidence-heading">Evidence</h2>',
      '<dl>',
      '<div><dt>Present</dt><dd>' + escapeHtml(boolLabel(evidence.present === true)) + '</dd></div>',
      '<div><dt>Digest</dt><dd>' + escapeHtml(digestValue(evidence.digest) || NOT_AVAILABLE) + '</dd></div>',
      '<div><dt>Facts</dt><dd>' + escapeHtml(String(Number.isInteger(evidence.fact_count) ? evidence.fact_count : 0)) + '</dd></div>',
      '<div><dt>Claims</dt><dd>' + escapeHtml(String(Number.isInteger(evidence.claim_count) ? evidence.claim_count : 0)) + '</dd></div>',
      '<div><dt>Kinds</dt><dd>' + escapeHtml(kinds.length > 0 ? kinds.join(', ') : NOT_AVAILABLE) + '</dd></div>',
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
    if (card === 'final') return renderFinalCardHtml(safe);
    return '';
  }

  function unwrapExperience(data) {
    if (!data || typeof data !== 'object') return null;
    if (data.experience && typeof data.experience === 'object') return stripOwnerOnly(data.experience);
    var params = data.params && typeof data.params === 'object' ? data.params : null;
    var result = params && params.result && typeof params.result === 'object' ? params.result : params;
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
      var phrases = safe.summary && Array.isArray(safe.summary.phrases) ? safe.summary.phrases : [];
      var phrase = typeof safe.summary?.delegating === 'string'
        ? safe.summary.delegating
        : (phrases[0] || 'I am delegating this to Co-Engineer');
      var running = typeof safe.summary?.running === 'string' ? safe.summary.running : '';
      return {
        phrase: joinRunPhrases(phrase, running),
        objective: displayString(run.objective),
        base_sha: sha40(repository.base_sha) || NOT_AVAILABLE,
        digest: digestValue(repository.digest) || NOT_AVAILABLE,
        lanes: laneItems(run.lanes),
      };
    }
    if (card === 'final') {
      var finalCard = safe.final && typeof safe.final === 'object' ? safe.final : {};
      var git = finalCard.git && typeof finalCard.git === 'object' ? finalCard.git : {};
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
      return {
        verified_final: allowedVerified ? clipText(verified, QUESTION_MAX) : '',
        accepted_lanes: joinIds(finalCard.accepted_lanes),
        failed_lanes: joinIds(finalCard.failed_lanes),
        unresolved_lanes: joinIds(finalCard.unresolved_lanes),
        branch: displayString(git.branch),
        head: sha40(git.head) || NOT_AVAILABLE,
        tree: sha40(git.tree) || NOT_AVAILABLE,
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
    renderRunCardHtml: renderRunCardHtml,
    stripOwnerOnly: stripOwnerOnly,
    unwrapExperience: unwrapExperience,
    visiblePlainText: visiblePlainText,
  });

  global.CodexCoEngineerExperienceUi = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
