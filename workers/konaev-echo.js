// ═══════════════════════════════════════════════════════════════════════════
// Этот файл живёт в двух местах: в Cloudflare (боевой воркер) и в `workers/`
// репозитория (снимок). ИСТОЧНИК ИСТИНЫ — Cloudflare. Правишь в дашборде →
// потом обновляешь снимок. Если снимок разошёлся с продом — прав прод.
// ═══════════════════════════════════════════════════════════════════════════

// konaev-echo.js — канал 6 «Эхо эфира» на konaev.tv. Сделан по образцу
// unitycode-echo.js (doctorums/unitycode): RSS → сжатие LLM → хранилище.
// Отличия от образца:
//   • хранилище — Workers KV, а не Supabase: канал отдаёт одну маленькую
//     подборку (десятки записей), база и таблицы ему не нужны;
//   • ПОЛИТИКИ НЕТ ВООБЩЕ, и фильтр fail-closed: запись проходит только если
//     модель ЯВНО ответила political:false и tragic:false, текст прошёл
//     стоп-лист слов, а оба перевода (ru и kk) на месте. Любая ошибка, пустой
//     ответ, битый JSON, недостающее поле — запись отбрасывается. Лучше пустой
//     прогон, чем одно политическое эхо в телевизоре кабельщика;
//   • два языка: ru и kk (kk — машинный, как и черновики в запасе сайта);
//   • отдаёт GET /echo → {updated, live, items[]} ровно в формате, который
//     уже читает сайт (ECHO_CFG.worker в index.html, echoFetch).
//
// Как сайт этим пользуется (см. echoFetch в index.html): берёт /echo, и если
// updated старше 48 ч или годных записей меньше трёх — тихо остаётся на
// встроенном запасе. Поэтому `updated` двигается ТОЛЬКО после прогона, который
// реально дошёл до конца: сломался ключ LLM или все ленты — updated стоит,
// через 48 ч сайт сам откатится на запас. Это вторая половина fail-closed.
//
// Привязки и переменные (Cloudflare → Workers → konaev-echo → Settings):
//   ECHO_KV       (KV binding)  пространство KV, например `konaev-echo-kv`.
//                               Без него воркер не пишет и /echo отвечает 503.
//   LLM_API_KEY   (secret)      ключ OpenAI-совместимого шлюза. Если не задан,
//                               берётся MIMO_API_KEY (тот же ключ DotPoin, что у
//                               unitycode). Без ключа прогон пропускается.
//   LLM_URL       (var, опц.)   по умолчанию шлюз DotPoin, как в образце.
//   LLM_MODEL     (var, опц.)   по умолчанию mimo-v2.5.
//   ECHO_KEY      (secret)      произвольная строка для служебных адресов
//                               (/run, /live, /diag). Без неё они отвечают 404.
//   ECHO_SOURCES  (var, опц.)   RSS-ленты: JSON-массив в одну строку (надёжнее
//                               всего — поле в дашборде однострочное) или через
//                               пробел. Пусто — берутся DEFAULT_SOURCES ниже.
//   ECHO_KEEP_DAYS (var, опц.)  сколько дней держать запись, по умолчанию 7.
//
// Cron Trigger (Settings → Trigger events): например `0 */3 * * *` — раз в
// три часа. Интервал в коде не зашит.
//
// Служебные адреса (все с ?key=<ECHO_KEY>):
//   /run            быстрый прогон (2 ленты, до 2 записей), ответ — сводка;
//   /run?full=1     полный прогон в фоне (ответ сразу, итог — в /diag);
//   /run?full=1&wait=1  полный прогон с ожиданием сводки;
//   /live?on=1|0    «владелец в эфире» — плашка на канале, без передеплоя;
//   /diag           сводка последнего прогона, чтобы видеть причину нуля
//                   без логов Cloudflare (с iPad их не посмотреть).

const LLM_URL_DEFAULT = 'https://llms.dotpoin.com/v1/chat/completions';
const LLM_MODEL_DEFAULT = 'mimo-v2.5';

// Ленты по умолчанию: лёгкие новости, наука, природа, странности. Ни одной
// общеполитической — фильтр всё равно отсеет политику, но за каждую
// отсеянную запись уже заплачено вызовом LLM. Список не проверен отсюда
// вживую: первым делом после деплоя смотрим /diag — у мёртвой ленты fetched=0.
const DEFAULT_SOURCES = [
  'https://www.goodnewsnetwork.org/feed/',
  'https://www.positive.news/feed/',
  'https://www.sciencedaily.com/rss/strange_offbeat.xml',
  'https://www.sciencedaily.com/rss/plants_animals.xml',
  'https://www.smithsonianmag.com/rss/smart-news/',
  'https://www.atlasobscura.com/feeds/latest',
  'https://www.upi.com/rss/Odd_News/',
  'https://apod.nasa.gov/apod.rss',
];

const KV_PAYLOAD = 'echo';        // то, что отдаётся сайту
const KV_SEEN = 'echo:seen';      // хэши уже разобранных записей (и принятых, и отсеянных)
const KV_LIVE = 'echo:live';      // '1' — владелец в эфире
const KV_LAST = 'echo:last';      // сводка последнего прогона для /diag

const KEEP_DAYS_DEFAULT = 7;
const ITEMS_MAX = 60;             // потолок подборки: сайту за визит нужно три
const SEEN_MAX = 1500;            // хватает на недели лент, JSON — десятки КБ
const FEED_SCAN_MAX = 20;         // сколько свежих записей ленты смотреть за прогон
const PER_HOST_PER_RUN = 3;       // квота на редакцию, как в образце (правка 29.08)
const LLM_PER_RUN_MAX = 12;       // потолок платных вызовов за прогон (без повторов)
const DESC_MAX = 500;
// Free-план: не больше 50 исходящих fetch() за вызов. Запас, как в образце.
const SUBREQUEST_STOP_AT = 45;

// Небесные тела: Nominatim на «Moon» найдёт что-нибудь на Земле, поэтому для
// них модель отдаёт body, а расстояние берём отсюда (сайт считает по нему
// время света). Средние расстояния от Земли, км.
const BODIES = { moon: 384400, sun: 149600000, iss: 420 };

const ECHO_PROMPT = `Ты — редактор канала «Эхо эфира» на сайте кабельного телевидения маленького казахстанского города Конаев. Канал показывает зрителю одну короткую, лёгкую и правдивую новость из мира: «Пока вы листали ленту, в мире: …».

Тебе дают заголовок и начало новости. Реши, годится ли она, и если да — перескажи.

ГОДИТСЯ только если ВСЁ верно:
— это факт или событие, а не мнение, реклама, анонс, опрос или список;
— тема лёгкая: животные, природа, наука, космос, изобретения, рекорды, культура, еда, путешествия, забавные случаи;
— нет политики ни в каком виде: власти, выборы, партии, политики и чиновники, законы, санкции, пошлины, войны и армии, протесты, дипломатия, спорные территории;
— нет трагедии: гибель, болезни и эпидемии, насилие, преступления, суды, аварии, катастрофы, стихийные бедствия;
— нет религии и национальных споров.
Сомневаешься — не годится.

Как писать, если годится:
— ru: одна короткая фраза по-русски, до 70 знаков, с точкой в конце, спокойно и чуть с улыбкой, без оценок и восклицаний. Образцы тона: «Пингвин дослужился до генерала.» «Каланы спят, держась за лапы, чтобы не уплыть.» «Поезд ушёл на 20 секунд раньше. Компания извинилась.»
— kk: та же фраза по-казахски (кириллица), по смыслу, не дословно.
— place_en: где это случилось — город или регион и страна по-английски для геокодера («Monterey, USA»), иначе null.
— place_ru и place_kk: то же место коротко по-русски и по-казахски («Монтерей, США» / «Монтерей, АҚШ»), иначе null.
— body: если событие на Луне, Солнце или МКС — "moon", "sun" или "iss", иначе null.

Ответь СТРОГО одним JSON без markdown и пояснений:
{"ok":true или false,"political":true или false,"tragic":true или false,"ru":"...","kk":"...","place_en":"..." или null,"place_ru":"..." или null,"place_kk":"..." или null,"body":null}
Если не годится: {"ok":false,"political":...,"tragic":...}`;

// Стоп-лист — второй замок поверх ответа модели, не замена ему: промпт —
// просьба, а не гарантия (урок образца от 04.09). Проверяется и заголовок
// источника, и готовые ru/kk. Намеренно широкий: ложное срабатывание стоит
// одной записи, пропуск — доверия к каналу. Корни без границы справа, чтобы
// ловить падежи; слева — граница по букве (\b в JS не видит кириллицу).
const STOP_RU = ['президент', 'премьер', 'министр', 'правительств', 'парламент', 'депутат', 'сенат', 'конгресс',
  'выбор', 'голосован', 'референдум', 'партия', 'партии', 'санкци', 'пошлин', 'дипломат', 'посол',
  'войн', 'военн', 'армия', 'армии', 'солдат', 'ракет', 'обстрел', 'атак', 'теракт', 'террор',
  'протест', 'митинг', 'кремл', 'путин', 'трамп', 'байден', 'зеленск', 'токаев', 'си цзиньпин', 'нетаньяху',
  'погиб', 'гибел', 'смерт', 'умер', 'скончал', 'убий', 'убит', 'жертв', 'ранен', 'катастроф', 'авари', 'крушени',
  'пожар', 'землетрясен', 'наводнен', 'урага', 'эпидеми', 'пандеми', 'рак ', 'суд ', 'суда', 'арест', 'задержан',
  'полици', 'преступ', 'насили', 'религи', 'мечет', 'церк'];
const STOP_KK = ['президент', 'премьер', 'министр', 'үкімет', 'парламент', 'мәжіліс', 'сенат', 'депутат', 'сайлау',
  'партия', 'санкция', 'соғыс', 'әскер', 'зымыран', 'шабуыл', 'лаңкес', 'наразылық', 'митинг',
  'қаза', 'өлім', 'өлді', 'қайтыс', 'кісі өлтір', 'апат', 'өрт', 'жер сілкін', 'су тасқын', 'індет',
  'сот', 'қамау', 'полиция', 'қылмыс', 'зорлық', 'дін', 'мешіт', 'шіркеу'];
const STOP_EN = ['president', 'prime minister', 'minister', 'government', 'parliament', 'senate', 'congress', 'election',
  'vote', 'voting', 'referendum', 'party leader', 'sanction', 'tariff', 'diplomat', 'embassy', 'war ', 'wars', 'military',
  'army', 'troops', 'missile', 'airstrike', 'attack', 'terror', 'protest', 'kremlin', 'putin', 'trump', 'biden',
  'zelensky', 'netanyahu', 'xi jinping', 'gaza', 'israel', 'ukraine', 'killed', 'dead', 'death', 'dies', 'died',
  'murder', 'victim', 'injured', 'crash', 'disaster', 'wildfire', 'earthquake', 'flood', 'hurricane', 'epidemic',
  'pandemic', 'outbreak', 'court', 'lawsuit', 'arrest', 'police', 'crime', 'shooting', 'abuse', 'religio', 'church', 'mosque'];

function stopHit(text, list) {
  const s = ' ' + String(text || '').toLowerCase().replace(/ё/g, 'е') + ' ';
  for (const w of list) {
    const i = s.indexOf(w.replace(/ё/g, 'е'));
    if (i > 0 && !/\p{L}/u.test(s[i - 1])) return w;
  }
  return null;
}

function parseSources(env) {
  const raw = (env.ECHO_SOURCES || '').trim();
  if (!raw) return DEFAULT_SOURCES.slice();
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter(Boolean).map(String);
  } catch (_) { /* не JSON — список через пробелы ниже */ }
  // По любому пробельному символу: поле в дашборде однострочное и склеивает
  // построчный список через пробелы (фикс 30.08 в образце).
  return raw.split(/\s+/).map(s => s.trim()).filter(Boolean);
}

function keepDays(env) {
  const n = parseInt(env.ECHO_KEEP_DAYS, 10);
  return Number.isFinite(n) && n > 0 ? n : KEEP_DAYS_DEFAULT;
}

// ── RSS/Atom без DOMParser (в Workers его нет) — как в образце ─────────────
function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-f]+|amp|lt|gt|quot|apos|nbsp);/gi, (m, e) => {
    const k = e.toLowerCase();
    if (k === 'amp') return '&'; if (k === 'lt') return '<'; if (k === 'gt') return '>';
    if (k === 'quot') return '"'; if (k === 'apos') return "'"; if (k === 'nbsp') return ' ';
    const n = k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
    return Number.isFinite(n) ? String.fromCodePoint(n) : m;
  });
}
function stripCdata(s) {
  if (!s) return '';
  const m = s.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  // Тег → пробел, чтобы слова по краям разметки не слипались (см. образец).
  return decodeEntities((m ? m[1] : s)).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}
function tag(block, name) {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i'));
  return m ? stripCdata(m[1]) : '';
}
function itemLink(block) {
  const href = block.match(/<link[^>]*href=["']([^"']+)["']/i);
  if (href) return href[1];
  return tag(block, 'link');
}
function parseFeedItems(xml) {
  const items = [];
  const blocks = xml.match(/<item\b[\s\S]*?<\/item>/gi) || xml.match(/<entry\b[\s\S]*?<\/entry>/gi) || [];
  for (const block of blocks) {
    const title = tag(block, 'title');
    if (!title) continue;
    items.push({
      title,
      link: itemLink(block),
      desc: tag(block, 'description') || tag(block, 'summary') || tag(block, 'content'),
      pub: tag(block, 'pubDate') || tag(block, 'published') || tag(block, 'updated'),
    });
  }
  return items;
}

async function fetchFeed(url) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'KonaevEcho/1.0 (+https://konaev.tv)' } });
    if (!r.ok) return { items: [], err: 'http_' + r.status };
    return { items: parseFeedItems(await r.text()) };
  } catch (e) { return { items: [], err: 'throw: ' + String(e).slice(0, 80) }; }
}

async function hashId(seed) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(seed));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 24);
}

function hasCyrillic(s) { return !!s && /[Ѐ-ӿ]/.test(s); }
function hasLetters(s) { return !!s && /\p{L}/u.test(s); }
function cleanPhrase(s, max) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > max ? '' : t; // длиннее — не обрезаем посреди мысли, а отбрасываем
}
function cleanPlace(s) {
  const t = s == null ? '' : String(s).replace(/\s+/g, ' ').trim().slice(0, 60);
  return hasLetters(t) ? t : null;
}

// Один повтор — только на пустой ответ/сбой шлюза, как в образце (шлюз DotPoin
// периодически отвечает 200 с пустым телом). Отказ модели («не годится») —
// это ответ, а не сбой: его не переспрашиваем, иначе платили бы за второй
// шанс для политики.
async function judgeEcho(env, item, budget) {
  let res = await judgeEchoOnce(env, item, budget);
  if (res.echo || res.reject) return res;
  const first = res.fail || 'unknown';
  res = await judgeEchoOnce(env, item, budget);
  if (res.echo || res.reject) return res;
  return { fail: first + ' | повтор: ' + (res.fail || 'unknown') };
}

async function judgeEchoOnce(env, item, budget) {
  try {
    if (budget) budget.n++;
    const r = await fetch(env.LLM_URL || LLM_URL_DEFAULT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (env.LLM_API_KEY || env.MIMO_API_KEY) },
      body: JSON.stringify({
        model: env.LLM_MODEL || LLM_MODEL_DEFAULT,
        temperature: 0.3,
        max_tokens: 400, // два языка и три места — втрое больше, чем в образце
        messages: [
          { role: 'system', content: ECHO_PROMPT },
          { role: 'user', content: `Заголовок: ${item.title}\n\nНачало: ${(item.desc || '').slice(0, DESC_MAX) || '—'}` },
        ],
      }),
    });
    if (!r.ok) return { fail: 'http_' + r.status + ': ' + (await r.text()).slice(0, 120) };
    const d = await r.json();
    const msg = d?.choices?.[0]?.message || {};
    let raw = (msg.content || '').replace(/```json|```/g, '').trim();
    if (!raw && msg.reasoning_content) {
      const m = String(msg.reasoning_content).match(/\{[\s\S]*"ok"[\s\S]*\}/);
      if (m) raw = m[0];
    }
    if (!raw) return { fail: 'empty_response' };
    const p = JSON.parse(raw);
    return verdict(p);
  } catch (e) { return { fail: 'throw: ' + String(e).slice(0, 120) }; }
}

// Разбор ответа модели. Fail-closed: пропускаем только ЯВНОЕ «да» по каждому
// признаку. Отсутствующее поле, строка "false" вместо false, null — всё это
// отказ, а не «наверное, можно».
function verdict(p) {
  if (!p || typeof p !== 'object') return { reject: 'not_object' };
  if (p.ok !== true) return { reject: 'model_no' };
  if (p.political !== false) return { reject: 'political' };
  if (p.tragic !== false) return { reject: 'tragic' };
  const ru = cleanPhrase(p.ru, 90), kk = cleanPhrase(p.kk, 110);
  if (!ru || !hasCyrillic(ru)) return { reject: 'bad_ru' };
  if (!kk || !hasCyrillic(kk) || kk === ru) return { reject: 'bad_kk' };
  if (/https?:|www\./i.test(ru + kk)) return { reject: 'url_in_text' };
  const body = typeof p.body === 'string' && BODIES[p.body.toLowerCase()] ? p.body.toLowerCase() : null;
  return { echo: { ru, kk, place_en: body ? null : cleanPlace(p.place_en), pr: cleanPlace(p.place_ru), pk: cleanPlace(p.place_kk), body } };
}

// ── Геокодинг: Nominatim (OSM), без ключа, не чаще 1 запроса/с — как в образце.
let lastGeocodeAt = 0;
async function geocodePlace(place) {
  if (!place) return null;
  const wait = 1100 - (Date.now() - lastGeocodeAt);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastGeocodeAt = Date.now();
  try {
    const url = 'https://nominatim.openstreetmap.org/search?format=json&limit=1&q=' + encodeURIComponent(place);
    const r = await fetch(url, { headers: { 'User-Agent': 'KonaevEcho/1.0 (konaev.tv, канал «Эхо эфира»)' } });
    if (!r.ok) return null;
    const rows = await r.json();
    if (!Array.isArray(rows) || !rows.length) return null;
    const lat = parseFloat(rows[0].lat), lon = parseFloat(rows[0].lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
    // Две цифры после запятой (~1 км) — сайту нужно только расстояние до
    // Конаева. Разброс точек, как в образце, не нужен: карты здесь нет.
    return [Math.round(lat * 100) / 100, Math.round(lon * 100) / 100];
  } catch (e) { return null; }
}

function sourceHost(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch (e) { return null; }
}

function shuffleInPlace(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function kvJson(env, key, fallback) {
  try {
    const v = await env.ECHO_KV.get(key, 'json');
    return v == null ? fallback : v;
  } catch (e) { return fallback; }
}

// Общее тело сбора — и для cron, и для /run. Возвращает сводку; она же
// кладётся в KV для /diag.
async function runEchoCollection(env, opts = {}) {
  const summary = { ranAt: new Date().toISOString(), skipped: null, sources: [], judged: 0, accepted: 0, rejected: {}, failed: 0, failSamples: [] };
  if (!env.ECHO_KV) { summary.skipped = 'no_kv_binding'; return summary; }
  if (!env.LLM_API_KEY && !env.MIMO_API_KEY) { summary.skipped = 'no_llm_key'; return await saveLast(env, summary); }

  let sources = parseSources(env);
  if (!sources.length) { summary.skipped = 'no_sources'; return await saveLast(env, summary); }
  if (opts.maxSources) sources = sources.slice(0, opts.maxSources);
  const llmCap = opts.llmCap || LLM_PER_RUN_MAX;

  let used = 0;
  const budgetLeft = () => SUBREQUEST_STOP_AT - used;

  const [payload, seenArr] = await Promise.all([
    kvJson(env, KV_PAYLOAD, { updated: null, items: [] }),
    kvJson(env, KV_SEEN, []),
  ]);
  const seen = new Set(Array.isArray(seenArr) ? seenArr : []);

  // ФАЗА 1 — ленты параллельно (правка образца 22.08: последовательный обход
  // упирался во время вызова, а не в бюджет).
  const fetched = await Promise.all(sources.map(async url => {
    const { items, err } = await fetchFeed(url);
    const withIds = [];
    for (const item of items.slice(0, FEED_SCAN_MAX)) {
      const id = await hashId(item.link || `${url}|${item.pub || item.title}`);
      withIds.push({ item, id, url });
    }
    return { url, withIds, err };
  }));
  used += sources.length;
  const feedsOk = fetched.filter(f => !f.err).length;

  // ФАЗА 2 — отсев без LLM: уже разобранные и то, что режет стоп-лист прямо
  // по заголовку (за такие записи не платим вовсе). Квота на редакцию.
  const byHost = {};
  let stoppedByTitle = 0;
  for (const f of fetched) {
    for (const x of f.withIds) {
      if (seen.has(x.id)) continue;
      if (stopHit(x.item.title, STOP_EN) || stopHit(x.item.title, STOP_RU)) { seen.add(x.id); stoppedByTitle++; continue; }
      const host = sourceHost(f.url) || f.url;
      (byHost[host] = byHost[host] || []).push(x);
    }
  }
  const candidates = [];
  for (const bucket of Object.values(byHost)) {
    shuffleInPlace(bucket);
    candidates.push(...bucket.slice(0, opts.perHost || PER_HOST_PER_RUN));
  }
  shuffleInPlace(candidates);
  summary.rejected.stop_title = stoppedByTitle;

  // ФАЗА 3 — суд модели, пачками по 4; бюджет проверяется перед пачкой по
  // факту трат (правка образца 22.08). Резерв: 2 попытки + геокод на запись
  // и 3 записи в KV в конце.
  const CONC = 4;
  const judged = [];
  for (let i = 0; i < candidates.length && judged.length < llmCap; i += CONC) {
    if (budgetLeft() < CONC * 3 + 3) break;
    const chunk = candidates.slice(i, Math.min(i + CONC, i + llmCap - judged.length));
    const res = await Promise.all(chunk.map(async c => {
      const budget = { n: 0 };
      const j = await judgeEcho(env, c.item, budget);
      return { ...c, j, spent: budget.n };
    }));
    for (const r of res) { used += r.spent; judged.push(r); }
  }
  summary.judged = judged.length;

  // ФАЗА 4 — второй замок (стоп-лист по готовому тексту) и геокодинг строго
  // последовательно. Сбой шлюза — НЕ в seen: запись попробуем в следующий раз.
  // Отказ модели или стоп-лист — в seen: второй раз за неё не платим.
  const fresh = [];
  for (const r of judged) {
    if (r.j.fail) {
      summary.failed++;
      if (summary.failSamples.length < 5) summary.failSamples.push(r.j.fail);
      continue;
    }
    seen.add(r.id);
    if (r.j.reject) { summary.rejected[r.j.reject] = (summary.rejected[r.j.reject] || 0) + 1; continue; }
    const e = r.j.echo;
    const hit = stopHit(e.ru, STOP_RU) || stopHit(e.kk, STOP_KK) || stopHit(r.item.desc, STOP_EN);
    if (hit) { summary.rejected.stop_text = (summary.rejected.stop_text || 0) + 1; continue; }
    let ll = null, dist;
    if (e.body) dist = BODIES[e.body];
    else if (e.place_en && budgetLeft() >= 4) { ll = await geocodePlace(e.place_en); used++; }
    const it = { id: r.id, ru: e.ru, kk: e.kk, pr: e.pr || '', pk: e.pk || e.pr || '', ll, src: sourceHost(r.url), t: summary.ranAt };
    if (dist) it.dist = dist;
    fresh.push(it);
  }
  summary.accepted = fresh.length;

  // ФАЗА 5 — слить со старыми, выкинуть просроченные, записать. updated
  // двигаем только если прогон реально состоялся: хоть одна лента ответила и
  // шлюз не лёг целиком (все вызовы — сбой). Иначе оставляем старый updated —
  // сайт через 48 ч сам уйдёт на запас (fail-closed по свежести).
  const cutoff = Date.now() - keepDays(env) * 86400000;
  const old = (Array.isArray(payload.items) ? payload.items : []).filter(x => x && Date.parse(x.t) > cutoff);
  const ids = new Set(fresh.map(x => x.id));
  const items = fresh.concat(old.filter(x => !ids.has(x.id))).slice(0, ITEMS_MAX);
  const llmDown = judged.length > 0 && summary.failed === judged.length;
  const healthy = feedsOk > 0 && !llmDown;
  const next = { updated: healthy ? summary.ranAt : payload.updated, items };
  summary.healthy = healthy;
  summary.itemsTotal = items.length;

  const seenOut = Array.from(seen).slice(-SEEN_MAX);
  await Promise.all([
    env.ECHO_KV.put(KV_PAYLOAD, JSON.stringify(next)),
    env.ECHO_KV.put(KV_SEEN, JSON.stringify(seenOut)),
  ]);

  summary.sources = fetched.map(f => ({ url: f.url, fetched: f.withIds.length, err: f.err || null,
    candidates: candidates.filter(c => c.url === f.url).length }));
  summary.subrequestsUsed = used;
  return await saveLast(env, summary);
}

async function saveLast(env, summary) {
  try { if (env.ECHO_KV) await env.ECHO_KV.put(KV_LAST, JSON.stringify(summary)); } catch (e) { /* диагностика не критична */ }
  return summary;
}

function json(obj, status, extra) {
  return new Response(JSON.stringify(obj, null, 2), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8' }, extra || {}),
  });
}

// Данные публичные и только на чтение, поэтому CORS открыт всем: сайт живёт в
// iframe srcdoc, плюс превью через githack — перечислять источники незачем.
const PUBLIC = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=120' };

export default {
  async scheduled(event, env, ctx) {
    await runEchoCollection(env);
  },

  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (path === '/echo') {
      if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET' } });
      if (!env.ECHO_KV) return json({ updated: null, live: false, items: [] }, 503, PUBLIC);
      const [payload, live] = await Promise.all([kvJson(env, KV_PAYLOAD, null), env.ECHO_KV.get(KV_LIVE).catch(() => null)]);
      if (!payload) return json({ updated: null, live: live === '1', items: [] }, 503, PUBLIC);
      // Наружу — только поля, которые читает сайт (+ src для диагностики).
      const items = (payload.items || []).map(x => {
        const o = { ru: x.ru, kk: x.kk, pr: x.pr, pk: x.pk, ll: x.ll || null, src: x.src };
        if (x.dist) o.dist = x.dist;
        return o;
      });
      return json({ updated: payload.updated, live: live === '1', items }, 200, PUBLIC);
    }

    // Служебное — только с ключом. Без ключа — 404, как в образце: открытый
    // адрес не должен уметь тратить вызовы LLM.
    if (!env.ECHO_KEY || url.searchParams.get('key') !== env.ECHO_KEY) {
      return new Response('not found', { status: 404 });
    }
    if (path === '/live') {
      const on = url.searchParams.get('on') === '1';
      await env.ECHO_KV.put(KV_LIVE, on ? '1' : '0');
      return json({ live: on, note: 'сайт увидит через 2–3 минуты (кэш /echo и KV)' });
    }
    if (path === '/diag') {
      const [last, payload, live] = await Promise.all([kvJson(env, KV_LAST, null), kvJson(env, KV_PAYLOAD, null), env.ECHO_KV.get(KV_LIVE)]);
      return json({ last, updated: payload && payload.updated, items: payload ? payload.items.length : 0, live: live === '1' });
    }
    if (path === '/run') {
      const full = url.searchParams.get('full') === '1';
      if (full && url.searchParams.get('wait') === '1') return json(await runEchoCollection(env));
      if (full) {
        ctx.waitUntil(runEchoCollection(env));
        return json({ started: true, note: 'полный прогон идёт в фоне — итог через минуту в /diag' });
      }
      return json(await runEchoCollection(env, { maxSources: 2, perHost: 1, llmCap: 2 }));
    }
    return new Response('not found', { status: 404 });
  },
};
