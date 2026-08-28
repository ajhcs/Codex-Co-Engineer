(function (global) {
  'use strict';

  var shared = global.CodexCoEngineerExperienceUi || {};
  var TOOL_CALL_METHOD = shared.TOOL_CALL_METHOD || ('tools/' + 'call');
  var escapeHtml = shared.escapeHtml || function (value) {
    return String(value ?? '').replace(/[&<>"']/g, function (ch) {
      if (ch === '&') return '&amp;';
      if (ch === '<') return '&lt;';
      if (ch === '>') return '&gt;';
      if (ch === '"') return '&quot;';
      return '&#39;';
    });
  };
  var redactDisplay = shared.redactDisplay || function (value) { return String(value ?? ''); };
  var clipText = shared.clipText || function (value, maxChars) {
    var text = redactDisplay(value);
    if (text.length <= maxChars) return text;
    return text.slice(0, Math.max(0, maxChars - 1)) + '…';
  };
  var stripOwnerOnly = shared.stripOwnerOnly || function (value) { return value; };
  var unwrapExperience = shared.unwrapExperience || function () { return null; };
  var isForbiddenHostMethod = shared.isForbiddenHostMethod || function () { return false; };
  var parseHostContext = shared.parseHostContext || function () { return null; };
  var applyHostContext = shared.applyHostContext || function () { return false; };
  var displayString = shared.displayString || function (value, fallback) {
    if (typeof value !== 'string' || value.trim() === '') return fallback || 'Not available';
    return clipText(value, 512);
  };
  var visiblePlainText = shared.visiblePlainText || function (html) {
    return String(html ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  };

  var ATTENTION_PHRASE = 'Co-Engineer needs one decision from you';
  var AUTHORITY_SENTENCE = shared.CODEX_AUTHORITY_SENTENCE
    || 'Codex remains chief engineer, reviewer, and merge authority.';
  var ATTENTION_NOTE = 'One grouped decision. This card cannot merge, push, rebase, create a pull request, tag, or release. Unaffected assignments keep working.';
  var UNSUPPORTED_CODE = 'same_session_reply_unsupported';
  var RESPONSE_MAX = 4096;
  var QUESTION_LIMIT = 8;
  var OPTION_LIMIT = 8;
  var REPLY_ROUND = 1;
  var REPLY_ID = 'cce-attention-reply';
  var FORBIDDEN_ARG_KEYS = {
    wait_until: true,
    wait_ms: true,
    attention: true,
    cleanup: true,
    assignment_ids: true,
    task_id: true,
    reply: true,
    run: true,
    delegate: true,
    dispatch: true,
    merge: true,
    push: true,
    rebase: true,
    create_pr: true,
    tag: true,
    release: true,
  };
  var FORBIDDEN_UI_METHODS = {
    'ui/message': true,
    'ui/open-link': true,
    'ui/update-model-context': true,
    'ui/request-display-mode': true,
  };
  var STATUS_TEXT = {
    waiting: 'Waiting for the grouped questions.',
    ready: ATTENTION_PHRASE + '.',
    submitting: 'Sending your one decision.',
    submitted: 'Your one decision was sent. The same run continues.',
    already: 'This decision was already sent. The same run continues.',
    denied: 'This decision could not be sent because it is no longer current.',
    missing: 'This decision cannot be sent because required run details are missing.',
    unsupported_only: 'There is no same-session question to answer. Unresolved assignments stay visible.',
    unresolved: 'Some assignments cannot take a same-session reply, so they stay unresolved.',
  };

  function createReplayStore() {
    return { byRun: Object.create(null), identities: Object.create(null) };
  }

  var defaultReplayStore = createReplayStore();

  function asObject(value) {
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  }

  function safeToken(value, fallback) {
    var text = String(value || '').replace(/[^A-Za-z0-9_-]/g, '-').replace(/-+/g, '-');
    text = text.replace(/^-|-$/g, '');
    return text || fallback || 'item';
  }

  function uniqueStrings(values) {
    var seen = Object.create(null);
    var out = [];
    if (!Array.isArray(values)) return out;
    for (var i = 0; i < values.length; i += 1) {
      if (typeof values[i] !== 'string') continue;
      var item = clipText(values[i], 96).trim();
      if (item === '' || seen[item]) continue;
      seen[item] = true;
      out.push(item);
    }
    return out;
  }

  function groupQuestions(attention) {
    var source = Array.isArray(attention && attention.questions) ? attention.questions : [];
    var seen = Object.create(null);
    var grouped = [];
    for (var i = 0; i < source.length && grouped.length < QUESTION_LIMIT; i += 1) {
      var question = source[i];
      if (!question || typeof question !== 'object') continue;
      var key = String(question.assignment_id || '') + '\0' + String(question.question_id || '');
      if (seen[key]) continue;
      seen[key] = true;
      grouped.push(question);
    }
    return grouped;
  }

  function isUnsupportedQuestion(question) {
    if (!question) return false;
    return question.reply_capability === 'unsupported' || question.disposition === 'unresolved';
  }

  function isAnswerableQuestion(question) {
    if (!question || isUnsupportedQuestion(question)) return false;
    if (question.reply_capability && question.reply_capability !== 'same_session') return false;
    if (question.disposition === 'answered') return false;
    return typeof question.assignment_id === 'string' && question.assignment_id !== '';
  }

  function answerableQuestions(attention) {
    return groupQuestions(attention).filter(isAnswerableQuestion);
  }

  function clipResponse(value) {
    if (typeof value !== 'string') return '';
    return clipText(redactDisplay(value).trim(), RESPONSE_MAX);
  }

  function bindAttention(experience) {
    var safe = stripOwnerOnly(experience) || {};
    var attention = asObject(safe.attention) || {};
    var reply = asObject(attention.reply) || {};
    var runReply = asObject(reply.run_reply) || {};
    var nestedReply = asObject(runReply.reply) || {};
    var questions = groupQuestions(attention);
    var answerable = questions.filter(isAnswerableQuestion);
    var unsupported = uniqueStrings(
      Array.isArray(attention.unsupported && attention.unsupported.lanes)
        ? attention.unsupported.lanes
        : questions.filter(isUnsupportedQuestion).map(function (question) { return question.assignment_id; }),
    );
    var eventCursor = typeof reply.event_cursor === 'string' && reply.event_cursor !== ''
      ? reply.event_cursor
      : (answerable.map(function (question) { return question.event_cursor; }).find(function (value) {
        return typeof value === 'string' && value !== '';
      }) || null);
    var batchId = typeof runReply.batch_id === 'string' ? runReply.batch_id : (
      typeof nestedReply.batch_id === 'string' ? nestedReply.batch_id : null
    );
    var revision = Number.isInteger(runReply.expected_revision)
      ? runReply.expected_revision
      : (Number.isInteger(attention.revision) ? attention.revision : null);
    return {
      card: safe.card,
      run_id: typeof safe.run_id === 'string' ? safe.run_id : null,
      batch_id: batchId,
      revision: revision,
      event_cursor: eventCursor,
      cursor_resume: reply.cursor_resume === true,
      round: Number.isInteger(nestedReply.round) ? nestedReply.round : REPLY_ROUND,
      questions: questions,
      answerable: answerable,
      affected_lanes: uniqueStrings(attention.affected_lanes),
      unaffected_lanes: uniqueStrings(attention.unaffected_lanes),
      unresolved_lanes: unsupported,
      unsupported: asObject(attention.unsupported) || {
        lanes: unsupported,
        unresolved: unsupported.length > 0,
        code: unsupported.length > 0 ? UNSUPPORTED_CODE : null,
      },
      phrase: typeof safe.summary?.attention === 'string' ? safe.summary.attention : ATTENTION_PHRASE,
    };
  }

  function identityKey(bound) {
    if (!bound || !bound.run_id || !bound.batch_id || bound.revision == null || bound.event_cursor == null) {
      return null;
    }
    return [bound.run_id, bound.batch_id, String(bound.revision), bound.event_cursor].join('\n');
  }

  function missingAuthority(bound) {
    if (!bound || bound.card !== 'attention') return 'card_mismatch';
    if (!bound.run_id) return 'run_missing';
    if (!bound.batch_id) return 'batch_missing';
    if (!Number.isInteger(bound.revision)) return 'revision_missing';
    if (!bound.event_cursor) return 'cursor_missing';
    if (bound.round !== REPLY_ROUND) return 'round_mismatch';
    for (var i = 0; i < bound.answerable.length; i += 1) {
      var question = bound.answerable[i];
      if (!question.question_id || !question.session_id || !question.task_id) return 'question_mismatch';
      if (question.event_cursor && question.event_cursor !== bound.event_cursor) return 'cursor_mismatch';
    }
    return null;
  }

  function answersMatch(expected, actual) {
    if (!Array.isArray(expected) || !Array.isArray(actual) || expected.length !== actual.length) return false;
    var byAssignment = Object.create(null);
    for (var i = 0; i < expected.length; i += 1) byAssignment[expected[i].assignment_id] = expected[i];
    for (var j = 0; j < actual.length; j += 1) {
      var answer = actual[j];
      var item = byAssignment[answer.assignment_id];
      if (!item) return false;
      if (item.question_id !== answer.question_id) return false;
      if (item.session_id !== answer.session_id) return false;
      if (item.task_id !== answer.task_id) return false;
      if (typeof answer.response !== 'string' || answer.response === '') return false;
      if (answer.response.length > RESPONSE_MAX) return false;
    }
    return true;
  }

  function buildGroupedReply(bound, responses) {
    var answers = bound.answerable.map(function (question) {
      var response = responses && Object.prototype.hasOwnProperty.call(responses, question.assignment_id)
        ? responses[question.assignment_id]
        : (responses && responses[question.question_id]);
      return {
        assignment_id: question.assignment_id,
        question_id: question.question_id,
        session_id: question.session_id,
        task_id: question.task_id,
        response: clipResponse(response),
      };
    });
    return {
      batch_id: bound.batch_id,
      expected_revision: bound.revision,
      reply: {
        round: REPLY_ROUND,
        batch_id: bound.batch_id,
        answers: answers,
      },
    };
  }

  function authorizeReply(bound, runReply, responses) {
    var missing = missingAuthority(bound);
    if (missing) return { ok: false, code: missing };
    if (bound.answerable.length === 0) return { ok: false, code: 'unsupported_only' };
    if (!runReply || typeof runReply !== 'object') return { ok: false, code: 'reply_missing' };
    if (runReply.batch_id !== bound.batch_id) return { ok: false, code: 'batch_mismatch' };
    if (runReply.expected_revision !== bound.revision) return { ok: false, code: 'revision_mismatch' };
    var nested = asObject(runReply.reply);
    if (!nested) return { ok: false, code: 'reply_missing' };
    if (nested.round !== REPLY_ROUND) return { ok: false, code: 'round_mismatch' };
    if (nested.batch_id !== bound.batch_id) return { ok: false, code: 'batch_mismatch' };
    var expected = bound.answerable.map(function (question) {
      return {
        assignment_id: question.assignment_id,
        question_id: question.question_id,
        session_id: question.session_id,
        task_id: question.task_id,
      };
    });
    if (!answersMatch(expected, nested.answers)) return { ok: false, code: 'question_mismatch' };
    for (var i = 0; i < nested.answers.length; i += 1) {
      var answer = nested.answers[i];
      if (bound.unresolved_lanes.indexOf(answer.assignment_id) !== -1) {
        return { ok: false, code: 'unsupported_lane' };
      }
      if (bound.unaffected_lanes.indexOf(answer.assignment_id) !== -1) {
        return { ok: false, code: 'lane_mismatch' };
      }
    }
    if (responses) {
      var keys = Object.keys(responses);
      for (var k = 0; k < keys.length; k += 1) {
        var key = keys[k];
        var matchesAnswerable = bound.answerable.some(function (question) {
          return question.assignment_id === key || question.question_id === key;
        });
        if (!matchesAnswerable) return { ok: false, code: 'lane_mismatch' };
      }
    }
    return { ok: true, code: null };
  }

  function isPermittedReplyCall(message, bound) {
    if (!message || message.method !== TOOL_CALL_METHOD) return false;
    var params = asObject(message.params);
    if (!params || params.name !== 'task') return false;
    var args = asObject(params.arguments);
    if (!args) return false;
    var keys = Object.keys(args);
    for (var i = 0; i < keys.length; i += 1) {
      if (keys[i] !== 'run_id' && keys[i] !== 'run_reply') return false;
      if (FORBIDDEN_ARG_KEYS[keys[i]]) return false;
    }
    if (args.run_id !== bound.run_id) return false;
    return authorizeReply(bound, args.run_reply).ok === true;
  }

  function alreadySubmittedBound(bound, store) {
    var replay = store || defaultReplayStore;
    var key = identityKey(bound);
    if (bound && bound.run_id && replay.byRun[bound.run_id]) return true;
    if (key && replay.identities[key]) return true;
    return false;
  }

  function markSubmittedBound(bound, store) {
    var replay = store || defaultReplayStore;
    var key = identityKey(bound);
    if (bound && bound.run_id) replay.byRun[bound.run_id] = true;
    if (key) replay.identities[key] = true;
  }

  function resetSubmittedForTests() {
    defaultReplayStore.byRun = Object.create(null);
    defaultReplayStore.identities = Object.create(null);
  }

  function laneItemsHtml(ids, emptyLabel) {
    var names = uniqueStrings(ids);
    if (names.length === 0) return '<li class="cce-empty">' + escapeHtml(emptyLabel) + '</li>';
    return names.map(function (name) {
      return '<li><span class="cce-lane-flag">' + escapeHtml(name) + '</span></li>';
    }).join('');
  }

  function optionId(question, option, index) {
    return 'cce-answer-' + safeToken(question.assignment_id, 'q' + index) + '-' + safeToken(option, 'opt' + index);
  }

  function inputId(question, index) {
    return 'cce-answer-' + safeToken(question.assignment_id, 'q' + index);
  }

  function questionOptions(question) {
    if (!Array.isArray(question.options)) return [];
    var options = [];
    for (var i = 0; i < question.options.length && options.length < OPTION_LIMIT; i += 1) {
      if (typeof question.options[i] === 'string' && question.options[i].trim() !== '') {
        options.push(clipText(question.options[i], 128));
      }
    }
    return options;
  }

  function renderQuestionHtml(question, index, disabled) {
    var assignment = displayString(question.assignment_id, 'unnamed assignment');
    var prompt = displayString(question.question, 'Not available');
    var html = '<li>';
    if (!isAnswerableQuestion(question)) {
      html += '<p><strong>' + escapeHtml(assignment) + '</strong></p>';
      html += '<p>' + escapeHtml(prompt) + '</p>';
      html += '<p class="cce-unresolved">This assignment cannot take a same-session reply. It stays unresolved.</p>';
      html += '</li>';
      return html;
    }
    var fieldId = inputId(question, index);
    var options = questionOptions(question);
    html += '<fieldset>';
    html += '<legend id="' + escapeHtml(fieldId) + '-legend">' + escapeHtml(assignment) + ': ' + escapeHtml(prompt) + '</legend>';
    if (options.length > 0) {
      html += '<ul class="cce-options">';
      for (var i = 0; i < options.length; i += 1) {
        var optId = optionId(question, options[i], i);
        html += '<li>';
        html += '<input type="radio" name="' + escapeHtml(fieldId) + '" id="' + escapeHtml(optId) + '" value="' + escapeHtml(options[i]) + '"';
        html += disabled ? ' disabled' : '';
        html += i === 0 ? ' required' : '';
        html += '>';
        html += '<label for="' + escapeHtml(optId) + '">' + escapeHtml(options[i]) + '</label>';
        html += '</li>';
      }
      html += '</ul>';
    } else {
      html += '<label for="' + escapeHtml(fieldId) + '">Answer for ' + escapeHtml(assignment) + '</label>';
      html += '<textarea id="' + escapeHtml(fieldId) + '" name="' + escapeHtml(fieldId) + '" rows="3" maxlength="' + String(RESPONSE_MAX) + '"';
      html += disabled ? ' disabled' : ' required';
      html += '></textarea>';
    }
    html += '</fieldset></li>';
    return html;
  }

  function renderAttentionCardHtml(experience) {
    var bound = bindAttention(experience);
    var disabled = alreadySubmittedBound(bound, defaultReplayStore)
      || bound.answerable.length === 0
      || missingAuthority(bound);
    var questionsHtml = bound.questions.length === 0
      ? '<li class="cce-empty">Not available</li>'
      : bound.questions.map(function (question, index) {
        return renderQuestionHtml(question, index, disabled);
      }).join('');
    var status = alreadySubmittedBound(bound, defaultReplayStore)
      ? STATUS_TEXT.already
      : (bound.answerable.length === 0 && bound.questions.length > 0
        ? STATUS_TEXT.unsupported_only
        : (missingAuthority(bound) ? STATUS_TEXT.missing : STATUS_TEXT.ready));
    if (bound.unresolved_lanes.length > 0 && bound.answerable.length > 0 && status === STATUS_TEXT.ready) {
      status = STATUS_TEXT.ready + ' ' + STATUS_TEXT.unresolved;
    }
    return [
      '<main>',
      '<article class="cce-card cce-card-attention" data-cce-card="attention" data-cce-interactive="reply" aria-labelledby="cce-attention-title">',
      '<header>',
      '<h1 id="cce-attention-title">Co-Engineer grouped attention</h1>',
      '<p class="cce-phrase" data-field="phrase">' + escapeHtml(displayString(bound.phrase, ATTENTION_PHRASE)) + '</p>',
      '<p class="cce-authority">' + escapeHtml(AUTHORITY_SENTENCE) + '</p>',
      '</header>',
      '<section aria-labelledby="cce-questions-heading">',
      '<h2 id="cce-questions-heading">Questions</h2>',
      '<ol class="cce-questions" data-field="questions">' + questionsHtml + '</ol>',
      '</section>',
      '<section aria-labelledby="cce-affected-heading">',
      '<h2 id="cce-affected-heading">Affected assignments</h2>',
      '<p class="cce-note">These assignments need this one decision.</p>',
      '<ul class="cce-lane-names" data-field="affected_lanes">' + laneItemsHtml(bound.affected_lanes, 'Not available') + '</ul>',
      '</section>',
      '<section aria-labelledby="cce-unaffected-heading">',
      '<h2 id="cce-unaffected-heading">Unaffected assignments</h2>',
      '<p class="cce-note">These assignments keep working.</p>',
      '<ul class="cce-lane-names" data-field="unaffected_lanes">' + laneItemsHtml(bound.unaffected_lanes, 'Not available') + '</ul>',
      '</section>',
      '<section aria-labelledby="cce-unresolved-heading">',
      '<h2 id="cce-unresolved-heading">Unresolved assignments</h2>',
      '<p class="cce-note">Assignments that cannot take a same-session reply stay unresolved. They are not skipped and do not start another run.</p>',
      '<ul class="cce-lane-names" data-field="unresolved_lanes">' + laneItemsHtml(bound.unresolved_lanes, 'None') + '</ul>',
      '</section>',
      '<form class="cce-reply" data-cce-reply-form="true" id="cce-attention-form" action="#" method="post" novalidate>',
      '<p class="cce-visually-hidden" id="cce-reply-help">Send exactly one grouped decision for the current run. This does not merge, push, or start another run.</p>',
      '<button class="cce-submit" type="submit" id="cce-attention-submit" data-field="submit" aria-describedby="cce-reply-help"' + (disabled ? ' disabled' : '') + '>Send one decision</button>',
      '</form>',
      '<p class="cce-status" role="status" aria-live="polite" aria-atomic="true" id="cce-attention-status" data-field="status" tabindex="-1">' + escapeHtml(status) + '</p>',
      '<p class="cce-note">' + escapeHtml(ATTENTION_NOTE) + '</p>',
      '</article>',
      '</main>',
    ].join('');
  }

  function focusPlan(bound, state) {
    if (state === 'submitted' || state === 'already' || state === 'denied' || state === 'submitting' || state === 'missing') {
      return { target: 'cce-attention-status', reason: state || 'status' };
    }
    if (!bound || bound.answerable.length === 0) {
      return { target: 'cce-attention-status', reason: 'status' };
    }
    var first = bound.answerable[0];
    var options = questionOptions(first);
    if (options.length > 0) {
      return { target: optionId(first, options[0], 0), reason: 'first_option' };
    }
    return { target: inputId(first, 0), reason: 'first_input' };
  }

  function tabOrder(bound) {
    var order = [];
    if (!bound) return ['cce-attention-submit'];
    bound.answerable.forEach(function (question, index) {
      var options = questionOptions(question);
      if (options.length > 0) {
        options.forEach(function (option, optionIndex) {
          order.push(optionId(question, option, optionIndex));
        });
      } else {
        order.push(inputId(question, index));
      }
    });
    order.push('cce-attention-submit');
    return order;
  }

  function collectResponses(root, bound) {
    var responses = {};
    if (!bound) return responses;
    for (var i = 0; i < bound.answerable.length; i += 1) {
      var question = bound.answerable[i];
      var name = inputId(question, i);
      var options = questionOptions(question);
      if (options.length > 0 && root && typeof root.querySelector === 'function') {
        var selected = root.querySelector('input[name="' + name + '"]:checked');
        responses[question.assignment_id] = selected ? selected.value : '';
      } else if (root && typeof root.querySelector === 'function') {
        var field = root.querySelector('#' + name);
        responses[question.assignment_id] = field && typeof field.value === 'string' ? field.value : '';
      }
    }
    return responses;
  }

  function setLiveStatus(root, text, tone, motion) {
    if (!root || typeof root.querySelector !== 'function') return;
    var node = root.querySelector('[data-field="status"]') || root.querySelector('#cce-attention-status');
    if (!node) return;
    node.textContent = text;
    if (node.setAttribute) node.setAttribute('data-tone', tone || 'info');
    node.className = motion ? 'cce-status cce-state-change' : 'cce-status';
  }

  function setSubmitEnabled(root, enabled) {
    if (!root || typeof root.querySelector !== 'function') return;
    var button = root.querySelector('#cce-attention-submit') || root.querySelector('[data-field="submit"]');
    if (!button) return;
    button.disabled = !enabled;
  }

  function applyFocus(documentRef, plan) {
    if (!documentRef || !plan || !plan.target) return false;
    var node = typeof documentRef.getElementById === 'function'
      ? documentRef.getElementById(plan.target)
      : (documentRef.querySelector ? documentRef.querySelector('#' + plan.target) : null);
    if (!node || typeof node.focus !== 'function') return false;
    node.focus();
    return true;
  }

  function replaceList(documentRef, node, ids, emptyLabel) {
    while (node.firstChild) node.removeChild(node.firstChild);
    var names = uniqueStrings(ids);
    if (names.length === 0) {
      var empty = documentRef.createElement('li');
      empty.className = 'cce-empty';
      empty.textContent = emptyLabel;
      node.appendChild(empty);
      return;
    }
    for (var i = 0; i < names.length; i += 1) {
      var li = documentRef.createElement('li');
      var flag = documentRef.createElement('span');
      flag.className = 'cce-lane-flag';
      flag.textContent = names[i];
      li.appendChild(flag);
      node.appendChild(li);
    }
  }

  function paintDom(documentRef, root, bound, state) {
    if (!root || !documentRef || typeof root.querySelector !== 'function') return;
    var phrase = root.querySelector('[data-field="phrase"]');
    if (phrase) phrase.textContent = displayString(bound.phrase, ATTENTION_PHRASE);
    var questionsNode = root.querySelector('[data-field="questions"]');
    if (questionsNode) {
      questionsNode.innerHTML = bound.questions.length === 0
        ? '<li class="cce-empty">Not available</li>'
        : bound.questions.map(function (question, index) {
          return renderQuestionHtml(question, index, state !== 'ready');
        }).join('');
    }
    var affected = root.querySelector('[data-field="affected_lanes"]');
    if (affected) replaceList(documentRef, affected, bound.affected_lanes, 'Not available');
    var unaffected = root.querySelector('[data-field="unaffected_lanes"]');
    if (unaffected) replaceList(documentRef, unaffected, bound.unaffected_lanes, 'Not available');
    var unresolved = root.querySelector('[data-field="unresolved_lanes"]');
    if (unresolved) replaceList(documentRef, unresolved, bound.unresolved_lanes, 'None');
    setSubmitEnabled(root, state === 'ready');
    var statusKey = state === 'ready' && bound.unresolved_lanes.length > 0 ? 'ready' : state;
    var text = STATUS_TEXT[statusKey] || STATUS_TEXT.ready;
    if (state === 'ready' && bound.unresolved_lanes.length > 0) {
      text = STATUS_TEXT.ready + ' ' + STATUS_TEXT.unresolved;
    }
    setLiveStatus(root, text, state === 'denied' || state === 'missing' ? 'denied' : 'info', state !== 'waiting');
  }

  function createAttentionSession(options) {
    var opts = options && typeof options === 'object' ? options : {};
    var replayStore = opts.replayStore || createReplayStore();
    var outbound = [];
    var rejected = [];
    var painted = [];
    var sentReplyIds = [];
    var bound = null;
    var state = 'waiting';
    var inFlight = false;
    var focused = [];

    function send(message) {
      var method = message && typeof message.method === 'string' ? message.method : null;
      if (method === TOOL_CALL_METHOD) {
        if (!bound || !isPermittedReplyCall(message, bound)) {
          rejected.push(method);
          return false;
        }
        if (sentReplyIds.length > 0 || alreadySubmittedBound(bound, replayStore)) {
          rejected.push(method);
          return false;
        }
      } else if (method && (isForbiddenHostMethod(method) || FORBIDDEN_UI_METHODS[method])) {
        rejected.push(method);
        return false;
      } else if (method && method.indexOf('ui/') !== 0) {
        rejected.push(method);
        return false;
      }
      outbound.push(message);
      if (typeof opts.postMessage === 'function') opts.postMessage(message);
      return true;
    }

    function currentState() {
      if (bound && alreadySubmittedBound(bound, replayStore)) return sentReplyIds.length > 0 ? 'submitted' : 'already';
      if (inFlight) return 'submitting';
      if (!bound) return 'waiting';
      if (missingAuthority(bound)) return 'missing';
      if (bound.answerable.length === 0) return 'unsupported_only';
      return 'ready';
    }

    function focusNow(reasonState) {
      var plan = focusPlan(bound, reasonState || currentState());
      focused.push(plan);
      if (opts.document) applyFocus(opts.document, plan);
      return plan;
    }

    function paint(experience) {
      var safe = stripOwnerOnly(experience);
      if (!safe || safe.card !== 'attention') return false;
      var next = bindAttention(safe);
      if (bound && alreadySubmittedBound(bound, replayStore) && identityKey(next) !== identityKey(bound)) {
        state = 'denied';
        painted.push('attention');
        if (typeof opts.applyHtml === 'function') opts.applyHtml(renderAttentionCardHtml(safe));
        if (opts.root && opts.document) paintDom(opts.document, opts.root, bound, 'denied');
        setLiveStatus(opts.root, STATUS_TEXT.denied, 'denied', true);
        focusNow('denied');
        return false;
      }
      bound = next;
      state = currentState();
      painted.push('attention');
      if (typeof opts.applyHtml === 'function') opts.applyHtml(renderAttentionCardHtml(safe));
      if (opts.root && opts.document) paintDom(opts.document, opts.root, bound, state);
      focusNow(state);
      return true;
    }

    function submit(responses) {
      if (!bound) return { ok: false, code: 'missing_authority' };
      if (inFlight || alreadySubmittedBound(bound, replayStore) || sentReplyIds.length > 0) {
        state = 'already';
        setLiveStatus(opts.root, STATUS_TEXT.already, 'info', true);
        setSubmitEnabled(opts.root, false);
        focusNow('already');
        return { ok: false, code: 'already_submitted' };
      }
      var missing = missingAuthority(bound);
      if (missing) {
        state = 'missing';
        setLiveStatus(opts.root, STATUS_TEXT.missing, 'denied', true);
        setSubmitEnabled(opts.root, false);
        focusNow('missing');
        return { ok: false, code: missing };
      }
      var collected = responses && typeof responses === 'object'
        ? responses
        : collectResponses(opts.root, bound);
      var runReply = buildGroupedReply(bound, collected);
      var authorized = authorizeReply(bound, runReply, collected);
      if (!authorized.ok) {
        state = authorized.code === 'unsupported_only' ? 'unsupported_only' : 'denied';
        setLiveStatus(opts.root, STATUS_TEXT[state] || STATUS_TEXT.denied, 'denied', true);
        setSubmitEnabled(opts.root, false);
        focusNow(state);
        return authorized;
      }
      var message = {
        jsonrpc: '2.0',
        id: REPLY_ID,
        method: TOOL_CALL_METHOD,
        params: {
          name: 'task',
          arguments: {
            run_id: bound.run_id,
            run_reply: runReply,
          },
        },
      };
      inFlight = true;
      state = 'submitting';
      setSubmitEnabled(opts.root, false);
      setLiveStatus(opts.root, STATUS_TEXT.submitting, 'info', true);
      var sent = send(message);
      if (!sent) {
        inFlight = false;
        state = 'denied';
        setLiveStatus(opts.root, STATUS_TEXT.denied, 'denied', true);
        focusNow('denied');
        return { ok: false, code: 'delivery_denied' };
      }
      markSubmittedBound(bound, replayStore);
      sentReplyIds.push(REPLY_ID);
      inFlight = false;
      state = 'submitted';
      setLiveStatus(opts.root, STATUS_TEXT.submitted, 'info', true);
      focusNow('submitted');
      return { ok: true, code: null, message: message };
    }

    function handleMessage(data) {
      if (!data || typeof data !== 'object') return;
      var inboundMethod = typeof data.method === 'string' ? data.method : null;
      var hostContext = parseHostContext(data);
      if (hostContext && opts.document) applyHostContext(opts.document, hostContext);
      if (inboundMethod === 'ui/notifications/host-context-changed') return;
      if (inboundMethod && inboundMethod === TOOL_CALL_METHOD) {
        rejected.push(inboundMethod);
        return;
      }
      if (inboundMethod && isForbiddenHostMethod(inboundMethod) && inboundMethod.indexOf('ui/') !== 0) {
        rejected.push(inboundMethod);
        return;
      }
      if (inboundMethod && inboundMethod.indexOf('ui/') !== 0 && inboundMethod !== TOOL_CALL_METHOD
        && Object.prototype.hasOwnProperty.call(data, 'method')) {
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
              name: 'codex-co-engineer-experience-attention',
              version: '1',
            },
          },
        });
        return;
      }
      if (Object.prototype.hasOwnProperty.call(data, 'id') && data.id === REPLY_ID && !data.method) {
        if (data.error) {
          state = 'denied';
          setLiveStatus(opts.root, STATUS_TEXT.denied, 'denied', true);
          focusNow('denied');
        } else {
          state = 'submitted';
          setLiveStatus(opts.root, STATUS_TEXT.submitted, 'info', true);
          setSubmitEnabled(opts.root, false);
          focusNow('submitted');
        }
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

    if (opts.root && typeof opts.root.addEventListener === 'function') {
      var form = opts.root.querySelector ? opts.root.querySelector('[data-cce-reply-form]') : opts.root;
      if (form && typeof form.addEventListener === 'function') {
        form.addEventListener('submit', function (event) {
          if (event && typeof event.preventDefault === 'function') event.preventDefault();
          submit();
        });
      }
    }

    return Object.freeze({
      card: 'attention',
      handleMessage: handleMessage,
      paint: paint,
      start: start,
      submit: submit,
      focusPlan: function () { return focusPlan(bound, currentState()); },
      tabOrder: function () { return tabOrder(bound); },
      bound: function () { return bound; },
      state: function () { return currentState(); },
      outbound: outbound,
      rejected: rejected,
      painted: painted,
      sentReplyIds: sentReplyIds,
      focused: focused,
    });
  }

  function connectAttentionCard(target, options) {
    var documentRef = target || global.document;
    if (!documentRef || typeof documentRef.querySelector !== 'function') return null;
    var root = documentRef.querySelector('[data-cce-card="attention"]');
    if (!root) return null;
    var session = createAttentionSession({
      document: documentRef,
      root: root,
      replayStore: defaultReplayStore,
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

  function attentionDocumentHasForbiddenControls(html) {
    var markup = (shared.markupWithoutScripts || function (value) { return String(value ?? ''); })(html);
    if (/role\s*=\s*["']button["']/i.test(markup) && !/<button\b/i.test(markup)) return true;
    if (new RegExp('<' + 'a\\b[^>]*href\\s*=', 'i').test(markup)) return true;
    if (/\bon(?:click|submit|keydown|load)\s*=/i.test(markup)) return true;
    if (/\b(merge|push|rebase|create[_-]?pr|tag|release)\b/i.test(markup)
      && /<(?:button|input)\b/i.test(markup)
      && !/cannot merge, push, rebase/i.test(markup)) {
      return true;
    }
    return false;
  }

  var api = Object.freeze({
    ATTENTION_NOTE: ATTENTION_NOTE,
    ATTENTION_PHRASE: ATTENTION_PHRASE,
    AUTHORITY_SENTENCE: AUTHORITY_SENTENCE,
    REPLY_ID: REPLY_ID,
    RESPONSE_MAX: RESPONSE_MAX,
    STATUS_TEXT: STATUS_TEXT,
    TOOL_CALL_METHOD: TOOL_CALL_METHOD,
    alreadySubmittedBound: alreadySubmittedBound,
    answerableQuestions: answerableQuestions,
    createReplayStore: createReplayStore,
    attentionDocumentHasForbiddenControls: attentionDocumentHasForbiddenControls,
    authorizeReply: authorizeReply,
    bindAttention: bindAttention,
    buildGroupedReply: buildGroupedReply,
    connectAttentionCard: connectAttentionCard,
    createAttentionSession: createAttentionSession,
    focusPlan: focusPlan,
    groupQuestions: groupQuestions,
    identityKey: identityKey,
    isPermittedReplyCall: isPermittedReplyCall,
    markSubmittedBound: markSubmittedBound,
    missingAuthority: missingAuthority,
    renderAttentionCardHtml: renderAttentionCardHtml,
    resetSubmittedForTests: resetSubmittedForTests,
    tabOrder: tabOrder,
    visiblePlainText: visiblePlainText,
  });

  global.CodexCoEngineerAttentionUi = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
