"use strict";

const course = window.COURSE_LIBRARY.lessons;
const root = document.querySelector("#main");
const storageKey = "hanzi-island:v1:" + new URL("./", location.href).pathname;
const modes = { read: "认读", write: "听写" };
const statuses = { new: "未练", good: "已掌握", again: "待复习" };
const view = {
  lessonId: course.find(lesson => lesson.kind === "words")?.id ?? course[0]?.id,
  parentId: course[0]?.id,
  type: "entries",
  selections: new Map(),
  reviewMode: "read",
  reviewPicked: new Map(),
  shuffled: false,
  session: null
};

function blankState() {
  return { version: 1, lessons: [], progress: { read: {}, write: {} }, settings: { rate: 0.85 } };
}

let state = blankState();
let initialNotice = "";
try {
  const saved = localStorage.getItem(storageKey);
  if (saved) state = validateState(JSON.parse(saved));
} catch {
  initialNotice = "本机记录暂时无法读取。如有备份，可在家长管理中恢复。";
}

let noticeTimer;
function notice(message) {
  const box = document.querySelector("#notice");
  clearTimeout(noticeTimer);
  box.textContent = message;
  noticeTimer = setTimeout(() => { box.textContent = ""; }, 5000);
}

function changeState(update) {
  try {
    const saved = localStorage.getItem(storageKey);
    const next = saved ? validateState(JSON.parse(saved)) : structuredClone(state);
    update(next);
    localStorage.setItem(storageKey, JSON.stringify(next));
    state = next;
    return true;
  } catch {
    notice("无法保存到本机。请检查浏览器储存空间或权限。");
    return false;
  }
}

function replaceState(next) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(next));
    state = next;
    return true;
  } catch {
    notice("恢复失败，本机记录未替换。");
    return false;
  }
}

function validateState(value) {
  const validString = (text, max) => typeof text === "string" && text.length <= max;
  if (value?.version !== 1 || !Array.isArray(value.lessons) || !value.progress ||
      value.lessons.length > 500 || ![0.65, 0.85, 1].includes(value.settings?.rate)) {
    throw Error("backup format");
  }
  const next = blankState();
  const ids = new Set(course.map(item => item.id));
  next.settings.rate = value.settings.rate;
  for (const lesson of value.lessons) {
    if (!/^local-[a-f\d-]{16,36}$/.test(lesson?.id) || ids.has(lesson.id) ||
        !validString(lesson.title, 80) || !lesson.title.trim() ||
        !validString(lesson.author, 100) || !["words", "poem"].includes(lesson.kind) ||
        !Array.isArray(lesson.entries) || !lesson.entries.length || lesson.entries.length > 500) {
      throw Error("backup lesson");
    }
    const words = new Set();
    for (const entry of lesson.entries) {
      if (!Array.isArray(entry) || (entry.length !== 2 &&
          !(entry.length === 3 && entry[2] === "extra" && lesson.kind === "words")) ||
          !validString(entry[0], 160) ||
          !entry[0].trim() || words.has(entry[0]) || !validString(entry[1], 220)) {
        throw Error("backup entry");
      }
      words.add(entry[0]);
    }
    ids.add(lesson.id);
    next.lessons.push({ id: lesson.id, title: lesson.title, kind: lesson.kind,
      author: lesson.author, entries: lesson.entries.map(entry => entry.slice()) });
  }
  for (const mode of Object.keys(modes)) {
    const records = value.progress[mode];
    if (!records || typeof records !== "object" || Array.isArray(records)) throw Error("backup progress");
    for (const [key, result] of Object.entries(records)) {
      const parts = JSON.parse(key);
      if (!Array.isArray(parts) || parts.length !== 3 || !ids.has(parts[0]) ||
          !["entry", "char", "poem"].includes(parts[1]) || !validString(parts[2], 160) ||
          !["good", "again"].includes(result)) throw Error("backup result");
      next.progress[mode][key] = result;
    }
  }
  return next;
}

const lessons = () => [...course, ...state.lessons];
const findLesson = id => lessons().find(lesson => lesson.id === id);
const status = (item, mode) => state.progress[mode][item.key] ?? "new";
const escape = text => String(text).replace(/[&<>"']/g, character => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]
));

function itemsFor(lesson, type = "entries") {
  const make = (text, pinyin, category, kind, context = "") => ({
    key: JSON.stringify([lesson.id, kind, kind === "poem" ? "" : text]),
    title: lesson.title, text, pinyin, category, kind, context
  });
  if (type === "whole") {
    return [make(lesson.entries.map(([text]) => text).join("\n"), "", "整首", "poem")];
  }
  if (type === "chars") {
    const found = new Map();
    for (const [text, pinyin] of lesson.entries) {
      const chars = Array.from(text).filter(char => /\p{Script=Han}/u.test(char));
      const syllables = pinyin?.split(/\s+/) ?? [];
      chars.forEach((char, index) => {
        if (!found.has(char)) found.set(char, make(char, chars.length === syllables.length ?
          syllables[index] : "", "单字", "char", chars.length > 1 ? text : ""));
      });
    }
    return [...found.values()];
  }
  return lesson.entries.map(([text, pinyin = "", group]) => make(text, pinyin,
    lesson.kind === "poem" ? "诗句" : group === "extra" ? "补充" : "必学", "entry"));
}

function allItems(lesson) {
  return [...itemsFor(lesson), ...itemsFor(lesson, "chars"),
    ...(lesson.kind === "poem" ? itemsFor(lesson, "whole") : [])];
}

function resultLabel(item, mode) {
  const result = status(item, mode);
  return '<span class="badge ' + result + '">' + modes[mode] + ' · ' + statuses[result] + '</span>';
}

function itemButton(item, selected, action, index) {
  return '<button type="button" class="word" data-action="' + action + '" data-value="' + index +
    '" aria-pressed="' + selected + '"><strong>' + escape(item.kind === "poem" ? item.title : item.text) +
    '</strong>' + (action === "review-pick" ? '<span class="small subtle">' +
      escape(item.kind === "poem" ? "整首古诗" : item.title + " · " + item.category) + '</span>' : "") +
    '<span class="badges">' + resultLabel(item, "read") + resultLabel(item, "write") + '</span></button>';
}

function heading(title, subtitle, decoration = "") {
  return '<section class="hero"><div><h1>' + title + '</h1><p>' + subtitle + '</p></div>' +
    (decoration ? '<div class="tiles" aria-hidden="true">' + decoration + '</div>' : "") + '</section>';
}

function currentSelection(lesson, items) {
  const id = lesson.id + ":" + view.type;
  if (!view.selections.has(id)) view.selections.set(id, new Set(items.map(item => item.key)));
  return view.selections.get(id);
}

function selectPage() {
  const catalog = lessons();
  const lesson = findLesson(view.lessonId) ?? catalog[0];
  if (!lesson) return heading("选课练习", "可以在家长管理中添加课文。");
  view.lessonId = lesson.id;
  const items = itemsFor(lesson, view.type);
  const selected = currentSelection(lesson, items);
  const sections = [...new Set(items.map(item => item.category))].map(category =>
    '<section class="stack"><h3>' + category + '</h3><div class="word-grid">' +
    items.map((item, index) => item.category === category ?
      itemButton(item, selected.has(item.key), "pick", index) : "").join("") + '</div></section>'
  ).join("");
  return heading("选课练习", "今天想练哪一课？挑好字词，就可以开始认读或听写。", "<i>读</i><i>写</i>") +
    '<div class="columns section"><aside class="card stack" aria-labelledby="lesson-label">' +
    '<h2 id="lesson-label">课文目录</h2><div class="lesson-nav">' +
    catalog.map(item => '<button class="lesson" type="button" data-action="lesson" data-value="' + escape(item.id) +
      '" aria-current="' + (item.id === lesson.id) + '"><span>' + escape(item.title) + '</span>' +
      '<small>' + escape(item.group?.split(" · ")[0] || (item.id.startsWith("local-") ? "自定义" : "")) +
      '</small></button>').join("") + '</div></aside>' +
    '<section class="card stack"><div class="stack"><div><p class="small subtle">' +
    escape([lesson.group, lesson.author].filter(Boolean).join(" ／ ")) + '</p><h2>' + escape(lesson.title) +
    '</h2></div><div class="row" aria-label="练习范围">' +
    '<button type="button" data-toggle data-action="type" data-value="entries" aria-pressed="' +
    (view.type === "entries") + '">' + (lesson.kind === "poem" ? "逐句" : "按字词") + '</button>' +
    '<button type="button" data-toggle data-action="type" data-value="chars" aria-pressed="' +
    (view.type === "chars") + '">拆成单字</button>' + (lesson.kind === "poem" ?
      '<button type="button" data-toggle data-action="type" data-value="whole" aria-pressed="' +
      (view.type === "whole") + '">整首</button>' : "") + '</div></div>' +
    '<div class="row spread"><p id="picked-count" class="subtle lesson-summary" aria-live="polite"></p>' +
    '<div class="row"><button type="button" class="plain" data-action="all">全选</button>' +
    '<button type="button" class="plain" data-action="none">清空选择</button></div></div>' +
    '<div class="row practice-actions"><button class="primary" data-action="start" data-value="read">开始认读</button>' +
    '<button class="secondary" data-action="start" data-value="write">' +
    (view.type === "whole" ? "整首默写" : "开始听写") + '</button><label class="check">' +
    '<input type="checkbox" data-change="shuffle"' + (view.shuffled ? " checked" : "") + '>打乱顺序</label></div>' +
    (sections || '<p class="empty">这课没有可拆分的汉字。</p>') + '</section></div>';
}

function updatePicked(items, picked) {
  const count = items.filter(item => picked.has(item.key)).length;
  root.querySelector("#picked-count").textContent = "已选 " + count + " / " + items.length + " 项";
  root.querySelectorAll('[data-action="start"], [data-action="start-review"]').forEach(button => {
    button.disabled = count === 0;
  });
}

function reviewItems() {
  return lessons().flatMap(allItems).filter(item => status(item, view.reviewMode) === "again");
}

function reviewSelection(items) {
  return new Set(items.filter(item => view.reviewPicked.get(view.reviewMode + item.key) !== false)
    .map(item => item.key));
}

function reviewPage() {
  const entries = reviewItems();
  const picked = reviewSelection(entries);
  return heading("错词本", "标记为待复习的字词和诗句，会按认读、听写分别收在这里。") +
    '<section class="card stack section"><div class="row spread"><div class="row">' +
    Object.entries(modes).map(([key, label]) => '<button data-toggle data-action="review-mode" data-value="' +
      key + '" aria-pressed="' + (key === view.reviewMode) + '">' + label + '错词</button>').join("") +
    '</div><button class="primary" data-action="start-review">开始复习</button></div>' +
    '<p id="picked-count" class="subtle" aria-live="polite"></p>' +
    (entries.length ? '<div class="word-grid">' + entries.map((item, index) =>
      itemButton(item, picked.has(item.key), "review-pick", index)).join("") + '</div>' :
    '<p class="empty">这里还没有待复习的项目。</p>') + '</section>';
}

function parentPage() {
  const catalog = lessons();
  const lesson = findLesson(view.parentId) ?? catalog[0];
  const items = lesson ? allItems(lesson) : [];
  const total = catalog.flatMap(allItems);
  if (lesson) view.parentId = lesson.id;
  return heading("家长管理", "查看练习进度、添加课文，或把本机记录备份到文件。") +
    '<div class="parent-grid section"><section class="card stack"><h2>学习进度</h2><div class="metrics">' +
    Object.entries(modes).map(([mode, label]) => '<div class="metric"><span>' + label + '已掌握</span><strong>' +
      total.filter(item => status(item, mode) === "good").length + ' / ' + total.length +
      '</strong><span class="small subtle">' + total.filter(item => status(item, mode) === "again").length +
      ' 项待复习</span></div>').join("") +
    '</div><p class="small subtle">统计包含字词、单字、诗句和整首古诗。</p></section>' +
    '<section class="card stack"><h2>备份与恢复</h2><p class="subtle">备份包含认读、听写进度、自定义课文和语速。</p>' +
    '<div class="row"><button class="primary" data-action="export">导出备份</button>' +
    '<button data-action="import">选取备份</button><input type="file" name="backup" accept=".json,application/json" hidden></div></section>' +
    '<section class="card stack"><h2>自定义课文</h2><p class="subtle">新增的内容保存在这台设备。</p>' +
    '<div class="row"><button class="primary" data-action="import-lesson">导入字词表</button>' +
    '<button class="secondary" data-action="edit">添加课文</button>' +
    (lesson?.id.startsWith("local-") ? '<button data-action="edit" data-value="' + escape(lesson.id) +
    '">编辑选中课文</button><button class="warn" data-action="remove">删除选中课文</button>' : "") +
    '</div><div id="editor-slot"></div></section>' +
    '<section class="card stack"><h2>朗读设置</h2><label>普通话语速<select data-change="rate">' +
    [[0.65, "慢速"], [0.85, "适中"], [1, "正常"]].map(([n, label]) =>
      '<option value="' + n + '"' + (n === state.settings.rate ? " selected" : "") + '>' + label + '</option>').join("") +
    '</select></label><button class="secondary" data-action="voice-test">试听普通话</button>' +
    '<p class="small subtle">使用设备上的普通话语音。iPad 如无声音，可先在系统设置下载普通话语音，再重新打开应用。</p></section></div>' +
    '<section class="card stack section"><h2>按课调整进度</h2><label>选择课文<select data-change="parent-lesson">' +
    catalog.map(item => '<option value="' + escape(item.id) + '"' + (item.id === lesson?.id ? " selected" : "") +
      '>' + escape(item.title) + '</option>').join("") + '</select></label>' +
    '<details id="progress-details"><summary>查看和调整 ' + items.length + ' 项</summary>' +
    items.map((item, index) => '<div class="parent-item row spread"><strong>' + escape(item.kind === "poem" ?
      item.title : item.text) + ' <span class="small subtle">· ' + item.category + '</span></strong><div class="row">' +
      Object.entries(modes).map(([mode, label]) => '<label>' + label + '<select data-change="status" data-mode="' +
      mode + '" data-index="' + index + '" aria-label="' + escape((item.kind === "poem" ? item.title : item.text) + " " + label) +
      '">' + Object.entries(statuses).map(([key, statusLabel]) => '<option value="' + key + '"' +
        (status(item, mode) === key ? " selected" : "") + '>' + statusLabel + '</option>').join("") +
      '</select></label>').join("") + '</div></div>').join("") + '</details></section>' +
    '<details class="card section"><summary>在 iPad 上安装和使用</summary><p>用 Safari 打开应用，从「分享」菜单选择「添加到主屏幕」。' +
    '首次联网打开后，看到页脚的「离线内容已就绪」即可离线使用文字练习。换设备时，把备份存到「文件」并在新设备恢复。</p></details>';
}

function showEditor(id) {
  const original = findLesson(id);
  const form = document.querySelector("#lesson-form").content.firstElementChild.cloneNode(true);
  const slot = root.querySelector("#editor-slot");
  const field = name => form.elements.namedItem(name);
  function updateLabels() {
    const poem = field("kind").value === "poem";
    form.querySelector("[data-author]").hidden = !poem;
    form.querySelector("[data-extra]").hidden = poem;
    form.querySelector("[data-text-label]").firstChild.textContent = poem ?
      "每行一句诗，可在句后加「｜拼音」" : "必学词（每行一个，可在词后加「｜拼音」）";
  }
  if (original) {
    field("title").value = original.title;
    field("kind").value = original.kind;
    field("kind").disabled = true;
    field("author").value = original.author;
    const asLines = entries => entries.map(([word, pinyin]) => word + (pinyin ? "｜" + pinyin : "")).join("\n");
    field("content").value = asLines(original.entries.filter(entry => entry[2] !== "extra"));
    field("extra").value = asLines(original.entries.filter(entry => entry[2] === "extra"));
  }
  updateLabels();
  field("kind").addEventListener("change", updateLabels);
  form.addEventListener("submit", event => {
    event.preventDefault();
    const kind = field("kind").value;
    const error = saveLocalLesson({
      title: field("title").value, kind, author: field("author").value,
      required: field("content").value, extra: field("extra").value, original
    });
    if (error) notice(error);
    else showSavedLesson();
  });
  slot.replaceChildren(form);
  field("title").focus();
}

function saveLocalLesson({ title, kind = "words", required, extra = "", author = "", original }) {
  title = title.trim();
  const parse = (value, group) => value.split(/\r?\n/).map(line => {
    const [word, pinyin = ""] = line.split(/[｜|]/, 2);
    return [word.trim(), pinyin.trim(), ...group];
  }).filter(entry => entry[0]);
  const candidates = [...parse(required, []), ...(kind === "words" ? parse(extra, ["extra"]) : [])];
  const unique = new Map();
  for (const entry of candidates) {
    const prior = unique.get(entry[0]);
    if (prior && prior[2] !== entry[2]) return "「" + entry[0] + "」同时出现在两栏，请归到一栏后再保存。";
    if (!prior || !prior[1]) unique.set(entry[0], entry);
  }
  const entries = [...unique.values()];
  if (!title || title.length > 80 || !entries.length || entries.length > 500 ||
      entries.some(([word, pinyin]) => word.length > 160 || pinyin.length > 220)) {
    return "请填课名并保留至少一个条目。每课最多 500 项，每项正文最多 160 字。";
  }
  if (!original && state.lessons.length >= 500) return "已达到 500 课的保存上限。";
  const lesson = { id: original?.id ?? "local-" + crypto.randomUUID(),
    title, kind, entries, author: kind === "poem" ? author.trim() : "" };
  const kept = new Set(allItems(lesson).map(item => item.key));
  if (original && original.kind === "poem" &&
      original.entries.map(entry => entry[0]).join("\n") !== entries.map(entry => entry[0]).join("\n")) {
    kept.delete(itemsFor(lesson, "whole")[0].key);
  }
  if (!changeState(next => {
    if (!original && next.lessons.length >= 500) throw Error("lesson limit");
    if (original) {
      next.lessons = next.lessons.map(item => item.id === lesson.id ? lesson : item);
      pruneResults(next, lesson.id, kept);
    } else next.lessons.push(lesson);
  })) return "未能保存。请查看设备的储存空间，然后重试。";
  for (const type of ["entries", "chars", "whole"]) view.selections.delete(lesson.id + ":" + type);
  view.parentId = lesson.id;
  return "";
}

function showSavedLesson() {
  render();
  root.querySelector('[data-change="parent-lesson"]').focus();
  notice("课文已保存，可在「选课练习」中找到。");
}

async function importLesson() {
  if (document.querySelector("#lesson-import-dialog")) return;
  try {
    const { openLessonImport } = await import("./lesson-import.mjs");
    if (pageName() === "parent") openLessonImport(saveLocalLesson, showSavedLesson);
  } catch {
    notice("无法打开导入工具，请联网后重试。");
  }
}

function pruneResults(next, lessonId, kept = new Set()) {
  for (const records of Object.values(next.progress)) {
    for (const key of Object.keys(records)) {
      if (JSON.parse(key)[0] === lessonId && !kept.has(key)) delete records[key];
    }
  }
}

function confirmAction(title, message, confirmLabel) {
  const dialog = document.createElement("dialog");
  dialog.className = "stack";
  dialog.innerHTML = '<h2 id="confirm-title">' + escape(title) + '</h2><p>' + escape(message) +
    '</p><form method="dialog" class="row"><button value="cancel" autofocus>取消</button>' +
    '<button class="warn" value="yes">' + escape(confirmLabel) + '</button></form>';
  dialog.setAttribute("aria-labelledby", "confirm-title");
  document.body.append(dialog);
  dialog.showModal();
  return new Promise(resolve => dialog.addEventListener("close", () => {
    const accepted = dialog.returnValue === "yes";
    dialog.remove();
    resolve(accepted);
  }, { once: true }));
}

async function removeLesson() {
  const lesson = findLesson(view.parentId);
  if (!lesson?.id.startsWith("local-") || !await confirmAction("删除课文",
      "将删除「" + lesson.title + "」和该课的练习记录。", "删除")) return;
  if (changeState(next => {
    next.lessons = next.lessons.filter(item => item.id !== lesson.id);
    pruneResults(next, lesson.id);
  })) {
    render();
    notice("课文已删除。");
  }
}

function exportBackup() {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const date = new Date().toLocaleDateString("sv-SE");
  link.href = url;
  link.download = "字字岛备份-" + date + ".json";
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

async function importBackup(file) {
  if (!file) return;
  if (file.size > 25 * 1024 * 1024) {
    notice("备份文件太大，请选择字字岛导出的 JSON 备份。");
    return;
  }
  let next;
  try {
    next = validateState(JSON.parse((await file.text()).replace(/^\uFEFF/, "")));
  } catch {
    notice("无法读取这个备份，请选用字字岛导出的 JSON 文件。");
    return;
  }
  const count = Object.values(next.progress).reduce((sum, records) => sum + Object.keys(records).length, 0);
  if (!await confirmAction("恢复备份", "备份包含 " + count + " 条进度和 " + next.lessons.length +
      " 个自定义课文，将替换当前设备的记录和设置。", "恢复备份")) return;
  if (replaceState(next)) {
    view.selections.clear();
    view.reviewPicked.clear();
    render();
    notice("备份已恢复。");
  }
}



const synth = window.speechSynthesis;
let utterance;

function speak(text) {
  const voices = synth?.getVoices() ?? [];
  const mandarin = voices.filter(voice => voice.localService &&
    /^(cmn|zh)(?:[-_]Han[st])?(?:[-_](CN|TW|SG))?$/i.test(voice.lang));
  const voice = mandarin.find(item => /[-_](CN|Hans)(?:[-_]|$)/i.test(item.lang)) ?? mandarin[0];
  if (!voice || !window.SpeechSynthesisUtterance) {
    notice("设备未提供可用的本地普通话语音。可在家长管理中查看设置，或请家长读题。");
    return;
  }
  synth.cancel();
  utterance = new SpeechSynthesisUtterance(text.replace(/\n/g, " "));
  utterance.lang = voice.lang;
  utterance.voice = voice;
  utterance.rate = state.settings.rate;
  utterance.onerror = event => {
    if (!["interrupted", "canceled"].includes(event.error)) notice("普通话朗读未播放，请重试或请家长读题。");
  };
  synth.speak(utterance);
}
synth?.getVoices();

function shuffled(items) {
  const result = items.slice();
  for (let index = result.length - 1; index > 0; index--) {
    const other = Math.floor(Math.random() * (index + 1));
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}

function focusMain() {
  root.focus({ preventScroll: true });
  window.scrollTo(0, 0);
}

function startSession(items, mode, origin) {
  if (!items.length) return;
  view.session = { items: view.shuffled ? shuffled(items) : items, mode, origin,
    index: 0, good: 0, again: 0, skipped: 0, revealed: false, strokes: [] };
  render();
  focusMain();
}

function sessionPage() {
  const session = view.session;
  const { mode, index, items, good, again, skipped, origin } = session;
  const item = items[index];
  const exit = '<button class="plain" data-action="exit">' + (origin === "review" ? "返回错词本" : "返回选课") + '</button>';
  if (!item) {
    return '<section class="practice card stack"><h1>本轮完成</h1><p class="subtle">' +
      modes[mode] + ' · 共 ' + items.length + ' 项</p><div class="metrics">' +
      '<div class="metric">已掌握<strong>' + good + '</strong></div><div class="metric">待复习<strong>' +
      again + '</strong></div></div><p class="subtle">跳过 ' + skipped + ' 项</p><div class="row">' +
      '<button class="primary" data-action="retry">再练一轮</button>' + exit + '</div></section>';
  }
  const writing = mode === "write";
  const whole = item.kind === "poem";
  const visible = !writing || session.revealed;
  const answer = '<p class="answer' + (item.text.length > 4 ? ' long' : '') + '">' +
    escape(item.text).replace(/\n/g, "<br>") + '</p>';
  const pinyin = item.pinyin ? '<p class="pinyin" id="pinyin" hidden>' + escape(item.pinyin) + '</p>' : "";
  const readHelp = writing ? "" : '<p class="subtle">' + (whole ? "先读一遍这首诗。" : "先读出来，再给自己打分。") + '</p>';
  let controls = '<button class="plain" data-action="skip">跳过</button>';
  if (visible) {
    controls = '<button class="primary" data-action="grade" data-value="good">' +
      (writing ? "我写对了" : "我会读") + '</button><button class="warn" data-action="grade" data-value="again">' +
      (writing ? "还要练听写" : "还要练认读") + '</button>' + controls;
  }
  const audio = whole && writing ? (visible ?
    '<button type="button" class="secondary" data-action="listen">朗读整首</button>' : "") :
    '<button type="button" class="secondary" data-action="listen">' +
    (writing && !visible ? "播放听写" : "听朗读") + '</button>';
  const stage = visible ? answer + pinyin + readHelp :
    '<h2>' + (whole ? '默写整首古诗' : '听一听，写一写') + '</h2><p class="subtle">' +
    (whole ? "看着诗题，在下面或纸上默写全诗。" : "点击播放，在下面或纸上写好，再核对答案。") + '</p>';
  return '<section class="practice card stack"><div class="row spread"><h1>' + (whole && writing ? "古诗默写" : modes[mode]) +
    '</h1>' + exit + '</div><div class="row spread"><p class="subtle">' + escape(item.title) + '</p><p>' +
    (index + 1) + ' / ' + items.length + '</p></div><progress aria-label="本轮进度" value="' + index +
    '" max="' + items.length + '"></progress><div class="practice-stage" aria-live="polite">' + stage +
    '<div class="row controls">' + audio + (visible && item.pinyin ?
    '<button data-action="pinyin" aria-controls="pinyin" aria-expanded="false">显示拼音</button>' : "") +
    (writing && !whole && !visible ? '<button class="plain" data-action="parent-prompt">请家长读题</button>' : "") +
    '</div></div>' + (writing ? '<div class="stack"><div class="row spread"><h2>手写区</h2><div class="row">' +
      '<button data-action="undo">撤销一笔</button><button data-action="clear-canvas">清空手写</button></div></div>' +
      '<canvas height="' + (whole ? 235 : 145) + '" aria-label="手写练习区，也可以用纸笔练习"></canvas>' +
      (visible ? '<p class="subtle small">请对照自己的手写结果，选择下方的评分。</p>' :
        '<button class="primary" data-action="reveal">写好了，核对答案</button>') + '</div>' : "") +
    '<div class="row controls">' + controls + '</div></section>';
}

let pen;
function mountCanvas(canvas, strokes) {
  const context = canvas.getContext("2d");
  let pointer = null;
  let stroke = null;
  const draw = () => {
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.lineWidth = 3 * Math.min(window.devicePixelRatio || 1, 3);
    context.lineCap = "round";
    context.lineJoin = "round";
    context.strokeStyle = "#172d27";
    for (const path of strokes) {
      const [first, ...rest] = path;
      context.beginPath();
      context.moveTo(first.x * canvas.width, first.y * canvas.height);
      if (!rest.length) context.lineTo(first.x * canvas.width + .1, first.y * canvas.height);
      for (const point of rest) context.lineTo(point.x * canvas.width, point.y * canvas.height);
      context.stroke();
    }
    root.querySelectorAll('[data-action="undo"], [data-action="clear-canvas"]').forEach(button => {
      button.disabled = !strokes.length;
    });
  };
  const resize = () => {
    const rect = canvas.getBoundingClientRect();
    const scale = Math.min(window.devicePixelRatio || 1, 3);
    canvas.width = Math.max(1, Math.round(rect.width * scale));
    canvas.height = Math.max(1, Math.round(rect.height * scale));
    draw();
  };
  const point = event => {
    const rect = canvas.getBoundingClientRect();
    return { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height };
  };
  canvas.addEventListener("pointerdown", event => {
    if (pointer !== null || event.button !== 0) return;
    canvas.setPointerCapture(event.pointerId);
    pointer = event.pointerId;
    stroke = [point(event)];
    strokes.push(stroke);
    draw();
  });
  canvas.addEventListener("pointermove", event => {
    if (event.pointerId !== pointer) return;
    for (const sample of event.getCoalescedEvents?.().length ? event.getCoalescedEvents() : [event]) {
      stroke.push(point(sample));
    }
    draw();
  });
  for (const eventName of ["pointerup", "pointercancel", "lostpointercapture"]) {
    canvas.addEventListener(eventName, event => {
      if (event.pointerId === pointer) pointer = null;
    });
  }
  canvas.style.height = canvas.getAttribute("height") + "px";
  resize();
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  return { draw, disconnect: () => observer.disconnect() };
}

function advance(result) {
  const session = view.session;
  const item = session.items[session.index];
  if (!item) return;
  if (result !== "skipped" && !changeState(next => {
    next.progress[session.mode][item.key] = result;
  })) return;
  session[result]++;
  session.index++;
  session.revealed = false;
  session.strokes = [];
  synth?.cancel();
  render();
  focusMain();
}

function pageName() {
  const page = location.hash.slice(1);
  return ["learn", "review", "parent"].includes(page) ? page : "learn";
}

function restoreFocus(previous) {
  if (!previous || root.contains(previous) || previous === root) return;
  const { action, value, change, mode, index } = previous.dataset;
  Array.from(root.querySelectorAll("[data-action], [data-change]")).find(element =>
    action ? element.dataset.action === action && element.dataset.value === value :
      change && element.dataset.change === change && element.dataset.mode === mode &&
      element.dataset.index === index)?.focus({ preventScroll: true });
}

function render({ preserveFocus = false, keepDetails = false } = {}) {
  const previous = preserveFocus ? document.activeElement : null;
  const lessonScroll = root.querySelector(".lesson-nav")?.scrollTop ?? 0;
  const detailsOpen = keepDetails && root.querySelector("#progress-details")?.open;
  const page = pageName();
  pen?.disconnect();
  pen = null;
  document.querySelectorAll("nav a[data-page]").forEach(link => {
    if (link.dataset.page === page) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  root.innerHTML = view.session ? sessionPage() : page === "parent" ? parentPage() :
    page === "review" ? reviewPage() : selectPage();
  if (detailsOpen) root.querySelector("#progress-details").open = true;
  if (!view.session && page === "learn") {
    const lesson = findLesson(view.lessonId);
    if (lesson) {
      const items = itemsFor(lesson, view.type);
      updatePicked(items, currentSelection(lesson, items));
      root.querySelector(".lesson-nav").scrollTop = lessonScroll;
    }
  }
  if (!view.session && page === "review") {
    const items = reviewItems();
    updatePicked(items, reviewSelection(items));
  }
  const canvas = root.querySelector("canvas");
  if (canvas) pen = mountCanvas(canvas, view.session.strokes);
  restoreFocus(previous);
}

function visibleItems() {
  const lesson = findLesson(view.lessonId);
  const items = itemsFor(lesson, view.type);
  return { items, picked: currentSelection(lesson, items) };
}

const actions = {
  lesson(id) {
    view.lessonId = id;
    view.type = "entries";
    render({ preserveFocus: true });
  },
  type(type) {
    view.type = type;
    render({ preserveFocus: true });
  },
  pick(index, button) {
    const { items, picked } = visibleItems();
    const key = items[Number(index)].key;
    if (picked.has(key)) picked.delete(key);
    else picked.add(key);
    button.setAttribute("aria-pressed", String(picked.has(key)));
    updatePicked(items, picked);
  },
  all() {
    const { items, picked } = visibleItems();
    items.forEach(item => picked.add(item.key));
    render({ preserveFocus: true });
  },
  none() {
    visibleItems().picked.clear();
    render({ preserveFocus: true });
  },
  start(mode) {
    const { items, picked } = visibleItems();
    startSession(items.filter(item => picked.has(item.key)), mode, "learn");
  },
  "review-mode"(mode) {
    view.reviewMode = mode;
    render({ preserveFocus: true });
  },
  "review-pick"(index, button) {
    const items = reviewItems();
    const key = view.reviewMode + items[Number(index)].key;
    view.reviewPicked.set(key, view.reviewPicked.get(key) === false);
    button.setAttribute("aria-pressed", String(view.reviewPicked.get(key)));
    updatePicked(items, reviewSelection(items));
  },
  "start-review"() {
    const items = reviewItems();
    const picked = reviewSelection(items);
    startSession(items.filter(item => picked.has(item.key)), view.reviewMode, "review");
  },
  exit() {
    synth?.cancel();
    view.session = null;
    render();
    focusMain();
  },
  retry() {
    const { items, mode, origin } = view.session;
    startSession(items, mode, origin);
  },
  listen() {
    const item = view.session.items[view.session.index];
    speak(item.context ? item.context + "的" + item.text : item.text);
  },
  async "parent-prompt"() {
    const item = view.session.items[view.session.index];
    await confirmAction("请家长读题", "请家长读出「" + item.text + "」，然后关闭这个窗口。", "我读好了");
  },
  pinyin(_, button) {
    const pinyin = root.querySelector("#pinyin");
    pinyin.hidden = !pinyin.hidden;
    button.setAttribute("aria-expanded", String(!pinyin.hidden));
    button.textContent = pinyin.hidden ? "显示拼音" : "隐藏拼音";
  },
  reveal() {
    view.session.revealed = true;
    render();
    root.querySelector(".practice-stage").setAttribute("tabindex", "-1");
    root.querySelector(".practice-stage").focus({ preventScroll: true });
  },
  grade: advance,
  skip: () => advance("skipped"),
  undo() {
    view.session.strokes.pop();
    pen?.draw();
    if (!view.session.strokes.length) root.querySelector("canvas").scrollIntoView({ block: "nearest" });
  },
  "clear-canvas"() {
    view.session.strokes.length = 0;
    pen?.draw();
  },
  edit: showEditor,
  "import-lesson": importLesson,
  remove: removeLesson,
  export: exportBackup,
  import: () => root.querySelector('[name="backup"]').click(),
  "voice-test": () => speak("你好，欢迎来到字字岛。")
};

root.addEventListener("click", event => {
  const button = event.target.closest("button[data-action]");
  if (!button || button.disabled) return;
  actions[button.dataset.action]?.(button.dataset.value, button);
});

root.addEventListener("change", event => {
  const field = event.target;
  if (field.name === "backup") {
    const file = field.files[0];
    field.value = "";
    importBackup(file);
  }
  switch (field.dataset.change) {
    case "shuffle":
      view.shuffled = field.checked;
      break;
    case "parent-lesson":
      view.parentId = field.value;
      render({ preserveFocus: true, keepDetails: true });
      break;
    case "rate":
      changeState(next => { next.settings.rate = Number(field.value); });
      render({ preserveFocus: true, keepDetails: true });
      break;
    case "status": {
      const item = allItems(findLesson(view.parentId))[Number(field.dataset.index)];
      const mode = field.dataset.mode;
      if (changeState(next => {
        if (field.value === "new") delete next.progress[mode][item.key];
        else next.progress[mode][item.key] = field.value;
      })) notice("进度已更新。");
      render({ preserveFocus: true, keepDetails: true });
      break;
    }
  }
});

let lastPage = pageName();
document.querySelector(".bar").addEventListener("click", event => {
  const link = event.target.closest('a[href^="#"]');
  if (view.session && link?.hash === location.hash) actions.exit();
});
window.addEventListener("hashchange", () => {
  if (location.hash === "#main") return;
  const page = pageName();
  if (page !== lastPage || view.session) {
    synth?.cancel();
    view.session = null;
    lastPage = page;
    render();
    focusMain();
  }
});

window.addEventListener("storage", event => {
  if (event.key !== storageKey) return;
  try {
    state = event.newValue ? validateState(JSON.parse(event.newValue)) : blankState();
    if (!view.session) {
      view.selections.clear();
      view.type = "entries";
      render({ keepDetails: true });
    }
  } catch {
    notice("另一窗口的学习记录无法读取。");
  }
});

render();
if (initialNotice) notice(initialNotice);

if ("serviceWorker" in navigator && /^https?:$/.test(location.protocol)) {
  const offlineLabel = document.querySelector("#offline");
  const markOffline = () => { offlineLabel.textContent = "离线内容已就绪 · 记录保存在本机"; };
  navigator.serviceWorker.register("./sw.js").then(async registration => {
    await navigator.serviceWorker.ready;
    if (registration.active) markOffline();
    const announceUpdate = () => {
      offlineLabel.textContent = "新版本已准备好 · 关闭各窗口后重新打开即可更新";
    };
    const track = worker => worker?.addEventListener("statechange", () => {
      if (worker.state === "installed" && navigator.serviceWorker.controller) announceUpdate();
    });
    if (registration.waiting) announceUpdate();
    track(registration.installing);
    registration.addEventListener("updatefound", () => track(registration.installing));
  }).catch(() => { offlineLabel.textContent = "离线内容尚未就绪 · 记录保存在本机"; });
}

