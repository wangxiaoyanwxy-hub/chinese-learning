
const assets = new URL("./", import.meta.url);
const asset = name => new URL(name, assets).href;
const MAX_PAGES = 20;
const MAX_BYTES = 30 * 1024 * 1024;
const REQUIRED = /必学(?:词句|词语|词)?|必写(?:词语|词)?/u;
const EXTRA = /(?:补充|拓展|选学)(?:词语|词句|词)?/u;
const LESSON = /课文(?:篇目|名称)?|课次|篇目/u;
const HAN = /\p{Script=Han}/u;
let tesseractScript;

function loadTesseract() {
  tesseractScript ??= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = asset("tesseract.min.js");
    script.onload = () => resolve(window.Tesseract);
    script.onerror = () => {
      script.remove();
      reject(Error("无法载入识别组件，请联网后重试。"));
    };
    document.head.append(script);
  }).catch(error => {
    tesseractScript = null;
    throw error;
  });
  return tesseractScript;
}

function stopIfAborted(signal) {
  if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
}

function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException("Cancelled", "AbortError"));
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

async function openOcr(signal, report) {
  const Tesseract = await loadTesseract();
  stopIfAborted(signal);
  report("正在准备中文识别组件…", null);
  let rejectSetup;
  const setupFailure = new Promise((_, reject) => { rejectSetup = reject; });
  const startup = Tesseract.createWorker("chi_sim+eng", Tesseract.OEM.LSTM_ONLY, {
    workerPath: asset("worker.min.js"),
    corePath: assets.href,
    langPath: assets.href.replace(/\/$/, ""),
    workerBlobURL: false,
    legacyCore: false,
    errorHandler: rejectSetup,
    logger(message) {
      if (message.status === "recognizing text") report(null, message.progress);
    }
  }).then(result => {
    if (signal.aborted) result.terminate();
    return result;
  });
  const worker = await abortable(Promise.race([startup, setupFailure]), signal);
  try {
    await abortable(worker.setParameters({ tessedit_pageseg_mode: Tesseract.PSM.SPARSE_TEXT }), signal);
    return worker;
  } catch (error) {
    await worker.terminate();
    throw error;
  }
}

async function canvasFromImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    try {
      await image.decode();
    } catch {
      throw Error("无法读取这张图片。请在 iPad 上截图后，再选取截图或 JPG、PNG 图片。");
    }
    const scale = Math.min(1, 3000 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d", { alpha: false });
    context.fillStyle = "white";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function previewBlob(canvas) {
  const thumb = document.createElement("canvas");
  const scale = Math.min(1, 1200 / Math.max(canvas.width, canvas.height));
  thumb.width = Math.max(1, Math.round(canvas.width * scale));
  thumb.height = Math.max(1, Math.round(canvas.height * scale));
  thumb.getContext("2d", { alpha: false }).drawImage(canvas, 0, 0, thumb.width, thumb.height);
  return new Promise(resolve => thumb.toBlob(resolve, "image/jpeg", 0.91));
}

function spreadCharacters(text, x0, x1, y0, y1) {
  const letters = Array.from(text);
  const width = char => HAN.test(char) ? 1 : /\s/u.test(char) ? 0.9 : 0.56;
  const total = letters.reduce((sum, char) => sum + width(char), 0);
  const unit = total ? (x1 - x0) / total : 0;
  let left = x0;
  return letters.flatMap(char => {
    const right = left + unit * width(char);
    const glyph = { char, x0: left, x1: right, y0, y1 };
    left = right;
    return HAN.test(char) ? [glyph] : [];
  });
}

async function ocrGlyphs(canvas, worker, signal) {
  stopIfAborted(signal);
  const { data } = await abortable(worker.recognize(canvas, {}, { blocks: true, text: false }), signal);
  return (data.blocks ?? []).flatMap(block => block.paragraphs.flatMap(paragraph =>
    paragraph.lines.flatMap(line => line.words.flatMap(word => {
      const { x0, x1, y0, y1 } = word.bbox;
      // A common baseline holds the characters of one word together in photographed tables.
      return word.symbols?.length ? word.symbols.flatMap(symbol =>
        spreadCharacters(symbol.text, symbol.bbox.x0, symbol.bbox.x1, y0, y1)) :
        spreadCharacters(word.text, x0, x1, y0, y1);
    }))
  ));
}

function pdfGlyphs(pdf, viewport, content) {
  return content.items.flatMap(item => {
    if (!item.str || !HAN.test(item.str)) return [];
    const [a, b, c, d, x, y] = pdf.Util.transform(viewport.transform, item.transform);
    if (Math.abs(b) > Math.abs(a) * 0.4) return [];
    const height = Math.hypot(c, d) || item.height || 12;
    return spreadCharacters(item.str, x, x + Math.max(item.width, height), y - height, y);
  });
}

function decodePdfData(encoded) {
  if (typeof encoded !== "string") throw Error("PDF resource not found");
  return Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
}

async function scanResolution(pdf, page, viewport, signal) {
  const operators = await abortable(page.getOperatorList(), signal);
  const pageRatio = viewport.width / viewport.height;
  const dimensions = operators.fnArray.flatMap((operator, index) => {
    if (operator !== pdf.OPS.paintImageXObject) return [];
    const [, width, height] = operators.argsArray[index];
    const ratio = width / height;
    const matchesPage = [ratio, 1 / ratio].some(value => Math.abs(Math.log(value / pageRatio)) < 0.27);
    return matchesPage && width >= 400 && height >= 400 ? [Math.max(width, height)] : [];
  });
  return dimensions.length ? Math.min(2400, Math.max(950, ...dimensions)) : 2400;
}

function groupsFromGlyphs(glyphs, pageWidth, previous) {
  const detected = glyphs.filter(glyph => glyph.x1 > glyph.x0 && glyph.y1 > glyph.y0);
  const median = numbers => {
    const ordered = numbers.slice().sort((a, b) => a - b);
    return ordered[Math.floor(ordered.length / 2)] ?? 1;
  };
  const glyphHeight = median(detected.map(item => item.y1 - item.y0));
  const sorted = detected.filter(item => item.y1 - item.y0 >= glyphHeight * 0.65);
  const glyphWidth = median(sorted.map(item => item.x1 - item.x0));
  const middle = item => (item.y0 + item.y1) / 2;
  const rows = [];
  for (const glyph of sorted.sort((a, b) => middle(a) - middle(b))) {
    const row = rows.at(-1);
    const y = middle(glyph);
    if (row && y - row.start <= glyphHeight * 0.67) {
      row.glyphs.push(glyph);
    } else rows.push({ start: y, glyphs: [glyph] });
  }
  for (const row of rows) {
    row.glyphs.sort((a, b) => a.x0 - b.x0);
    row.text = row.glyphs.map(item => item.char).join("");
  }
  const header = rows.findIndex(row => REQUIRED.test(row.text) &&
    (EXTRA.test(row.text) || LESSON.test(row.text) || row.text.length <= 8));
  const headerRow = rows[header];
  const requiredHeading = headerRow?.text.match(REQUIRED);
  const extraHeading = headerRow?.text.match(EXTRA);
  const lessonHeading = headerRow?.text.match(LESSON);
  const firstX = match => headerRow.glyphs[match.index].x0;
  let layout = previous;
  if (requiredHeading) {
    const requiredX = firstX(requiredHeading);
    layout = {
      left: lessonHeading && firstX(lessonHeading) < requiredX ?
        Math.max(0, requiredX - (requiredX - firstX(lessonHeading)) * 0.65) / pageWidth : 0,
      extra: extraHeading && firstX(extraHeading) > requiredX ?
        Math.max(requiredX, firstX(extraHeading) - glyphWidth * 1.15) / pageWidth : null
    };
  }
  const left = (layout?.left ?? 0) * pageWidth;
  const extraStart = layout?.extra == null ? Infinity : layout.extra * pageWidth;
  const required = [];
  const extra = [];
  for (const row of rows.slice(header + 1)) {
    if (/^(?:第.{0,7}单元|.{0,10}年级中文|学年|课文篇目|必学词句|补充词语)/u.test(row.text) ||
        /默写.{0,6}(?:古|十)诗/u.test(row.text)) continue;
    const words = [];
    for (const glyph of row.glyphs) {
      const x = (glyph.x0 + glyph.x1) / 2;
      const category = x < left ? null : x >= extraStart ? extra : required;
      const word = words.at(-1);
      const gap = glyph.x0 - (word?.end ?? -Infinity);
      if (word && gap <= glyphWidth * 0.67) {
        word.text += glyph.char;
        word.end = Math.max(word.end, glyph.x1);
      } else words.push({ text: glyph.char, end: glyph.x1, category });
    }
    for (const { text, category } of words) category?.push(text);
  }
  return { required, extra, layout };
}

async function extract(file, signal, report) {
  if (file.size > MAX_BYTES) throw Error("文件超过 30 MB，请压缩图片或把 PDF 分成较小的文件。");
  if (!file.size) throw Error("这个文件没有内容，请换一份再试。");
  const isPdf = /\.pdf$/i.test(file.name) || file.type === "application/pdf";
  if (!isPdf && !file.type.startsWith("image/") && !/\.(?:png|jpe?g|webp|heic|heif|avif|bmp)$/i.test(file.name)) {
    throw Error("请选择图片或 PDF 文件。");
  }

  let worker;
  let loading;
  let layout;
  const required = new Set();
  const extra = new Set();
  const previews = [];
  const recognize = async (canvas, label) => {
    worker ??= await openOcr(signal, report);
    report(label, 0);
    return ocrGlyphs(canvas, worker, signal);
  };
  const collect = async (glyphs, width, canvas) => {
    stopIfAborted(signal);
    const result = groupsFromGlyphs(glyphs, width, layout);
    layout = result.layout;
    result.required.forEach(word => required.add(word));
    result.extra.forEach(word => extra.add(word));
    previews.push(await previewBlob(canvas));
  };

  try {
    if (isPdf) {
      report("正在读取 PDF…", null);
      const [pdf, { default: resources }] = await Promise.all([
        import("./pdf.min.mjs"), import("./pdf-data.mjs")
      ]);
      pdf.GlobalWorkerOptions.workerSrc = asset("pdf.worker.min.mjs");
      const bytes = new Uint8Array(await file.arrayBuffer());
      stopIfAborted(signal);
      loading = pdf.getDocument({
        data: bytes, isEvalSupported: false, useWorkerFetch: false, useSystemFonts: true,
        CMapReaderFactory: class {
          async fetch({ name }) {
            return { cMapData: decodePdfData(resources.cmaps[name + ".bcmap"]), isCompressed: true };
          }
        },
        StandardFontDataFactory: class {
          async fetch({ filename }) {
            return decodePdfData(resources.fonts[filename]);
          }
        }
      });
      loading.onPassword = () => { loading.destroy().catch(() => {}); };
      let doc;
      try {
        doc = await abortable(loading.promise, signal);
      } catch (error) {
        if (error.name === "AbortError") throw error;
        throw Error("这个 PDF 无法打开。请确认文件可以正常打开，并使用未加密码的版本。");
      }
      if (doc.numPages > MAX_PAGES) throw Error("这份 PDF 超过 20 页，请将听写表所在页另存为 PDF 或截图。");
      for (let number = 1; number <= doc.numPages; number++) {
        stopIfAborted(signal);
        const label = "正在识别 PDF 第 " + number + " / " + doc.numPages + " 页…";
        report(label, null);
        const page = await abortable(doc.getPage(number), signal);
        const viewport = page.getViewport({ scale: 1 });
        const content = await abortable(page.getTextContent().catch(() => ({ items: [] })), signal);
        const glyphs = pdfGlyphs(pdf, viewport, content);
        const useText = glyphs.length >= 12 &&
          glyphs.filter(glyph => glyph.y1 <= viewport.height * 0.2).length < glyphs.length * 0.8;
        const resolution = useText ? 1200 : await scanResolution(pdf, page, viewport, signal);
        const scale = resolution / Math.max(viewport.width, viewport.height);
        const rendered = page.getViewport({ scale });
        const canvas = document.createElement("canvas");
        canvas.width = Math.ceil(rendered.width);
        canvas.height = Math.ceil(rendered.height);
        const draw = page.render({ canvasContext: canvas.getContext("2d", { alpha: false }), viewport: rendered });
        try {
          await abortable(draw.promise, signal);
          if (useText) await collect(glyphs, viewport.width, canvas);
          else await collect(await recognize(canvas, label), canvas.width, canvas);
        } finally {
          if (signal.aborted) draw.cancel();
          page.cleanup();
          canvas.width = canvas.height = 0;
        }
      }
    } else {
      report("正在读取图片…", null);
      const canvas = await canvasFromImage(file);
      try {
        await collect(await recognize(canvas, "正在识别图片…"), canvas.width, canvas);
      } finally {
        canvas.width = canvas.height = 0;
      }
    }
    return { required: [...required], extra: [...extra], previews };
  } finally {
    await Promise.allSettled([worker?.terminate(), loading?.destroy()]);
  }
}

export function openLessonImport(saveLesson, onSaved) {
  if (document.querySelector("#lesson-import-dialog")) return;
  const dialog = document.createElement("dialog");
  dialog.id = "lesson-import-dialog";
  dialog.className = "import-dialog";
  dialog.setAttribute("aria-labelledby", "lesson-import-title");
  dialog.innerHTML = `
    <form class="stack import-form">
      <div class="row spread"><h2 id="lesson-import-title">导入字词表</h2>
        <button type="button" data-close class="plain" aria-label="关闭导入">关闭</button></div>
      <label>选择图片或 PDF<input name="source" type="file" accept="image/*,.pdf,application/pdf"></label>
      <p class="subtle small">每次选择一份文件。原文件只在本机处理，第一次识别需联网加载识别组件。</p>
      <p data-status role="status" class="subtle" hidden></p>
      <progress aria-label="文字识别进度" hidden max="1"></progress>
      <div data-results class="stack" hidden>
        <label>课文名称<input name="title" maxlength="80"></label>
        <div class="import-columns">
          <label>必学词<textarea name="required" rows="7" spellcheck="false"></textarea></label>
          <label>补充词<textarea name="extra" rows="7" spellcheck="false"></textarea></label>
        </div>
        <p class="subtle small">请对照原表纠正错字、补上遗漏，或把词移到另一栏。每行一个词，可在词后加「｜拼音」。</p>
        <details data-preview><summary>查看原表</summary>
          <label data-page-picker>查看页码<select name="previewPage"></select></label>
          <img data-preview-image alt="导入文件的页面预览">
        </details>
        <p role="alert" data-error class="note sample" hidden></p>
        <div class="row"><button class="primary" type="submit">确认并保存</button>
          <button type="button" data-close>取消</button></div>
      </div>
    </form>`;
  const form = dialog.querySelector("form");
  const field = name => form.elements.namedItem(name);
  const status = dialog.querySelector("[data-status]");
  const progress = dialog.querySelector("progress");
  const results = dialog.querySelector("[data-results]");
  const preview = dialog.querySelector("[data-preview]");
  const previewImage = dialog.querySelector("[data-preview-image]");
  const problem = dialog.querySelector("[data-error]");
  let run;
  let saved = false;
  let urls = [];
  const clearPreviews = () => {
    previewImage.removeAttribute("src");
    urls.forEach(url => URL.revokeObjectURL(url));
    urls = [];
  };
  function report(label, fraction) {
    if (label !== null) {
      status.textContent = label;
      status.hidden = false;
    }
    progress.hidden = false;
    if (fraction === null) progress.removeAttribute("value");
    else progress.value = fraction;
  }

  field("source").addEventListener("change", async () => {
    const [file] = field("source").files;
    if (!file) return;
    field("source").value = "";
    field("source").disabled = true;
    results.hidden = true;
    problem.hidden = true;
    report("正在准备识别…", null);
    const current = new AbortController();
    run = current;
    try {
      const content = await extract(file, current.signal, report);
      stopIfAborted(current.signal);
      clearPreviews();
      urls = content.previews.map(blob => blob ? URL.createObjectURL(blob) : "");
      field("previewPage").replaceChildren(...urls.map((_, index) => new Option("第 " + (index + 1) + " 页", index)));
      dialog.querySelector("[data-page-picker]").hidden = urls.length < 2;
      preview.open = false;
      preview.hidden = !urls.some(Boolean);
      if (urls[0]) previewImage.src = urls[0];
      field("title").value = file.name.replace(/\.[^.]+$/, "").slice(0, 80);
      field("required").value = content.required.join("\n");
      field("extra").value = content.extra.join("\n");
      results.hidden = false;
      status.textContent = content.required.length || content.extra.length ?
        "已生成候选字词，请核对后保存。" : "没有识别到字词。可以查看原表、手动填写，或换一份文件重试。";
      field("title").focus();
    } catch (error) {
      if (!current.signal.aborted) status.textContent =
        error instanceof Error && /[\u4e00-\u9fff]/.test(error.message) ?
          error.message : "识别未完成。请保持联网后重试，或尝试截取字词所在区域。";
    } finally {
      if (!current.signal.aborted) {
        field("source").disabled = false;
        progress.hidden = true;
        run = null;
      }
    }
  });

  field("previewPage").addEventListener("change", () => {
    const url = urls[Number(field("previewPage").value)];
    if (url) previewImage.src = url;
    else previewImage.removeAttribute("src");
  });
  form.addEventListener("submit", event => {
    event.preventDefault();
    if (results.hidden || run) return;
    const error = saveLesson({
      title: field("title").value, required: field("required").value, extra: field("extra").value
    });
    if (error) {
      problem.textContent = error;
      problem.hidden = false;
      return;
    }
    saved = true;
    dialog.close();
  });
  dialog.querySelectorAll("[data-close]").forEach(button => button.addEventListener("click", () => dialog.close()));
  dialog.addEventListener("close", () => {
    run?.abort();
    clearPreviews();
    dialog.remove();
    if (saved) onSaved();
  }, { once: true });
  document.body.append(dialog);
  dialog.showModal();
}

