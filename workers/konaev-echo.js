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
//   ECHO_LOCAL_SOURCES (var, опц.) ленты для МЕСТНЫХ эхо (Конаев и Алматинская
//                               область), формат как у ECHO_SOURCES. Пусто — берутся
//                               DEFAULT_LOCAL_SOURCES. Пустой JSON-массив [] —
//                               местные эхо выключены.
//
// Местные эхо. Казахстанские ленты общие, про Конаев в них редко, поэтому
// до LLM берём только записи, где упомянуто место области (LOCAL_WORDS), —
// за остальные не платим. Дальше три проверки: модель подтверждает
// in_region (Конаев или Алматинская область, НЕ Алматы-город), геокод ложится
// не дальше LOCAL_RADIUS_KM от Конаева, стоп-лист с акиматами. Прошедшие
// помечаются loc:1; сайт подмешивает их примерно каждым третьим эхо.
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
//                   без логов Cloudflare (с iPad их не посмотреть);
//   /probe?url=…    проверить источник: есть ли лента, что воркер из него
//                   достаёт (первые заголовки), какие ленты объявлены на странице.
//
// Источник без RSS: если по адресу пришла обычная страница, а не лента,
// воркер берёт заголовки прямо из ссылок на ней (extractHtmlItems) — так
// читается, например, qonaev-gorod.kz/news. Хуже ленты (нет описаний и дат),
// поэтому для сайтов с RSS указывать надо саму ленту.

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
  // 26.09: прежние ленты публикуют по нескольку материалов в день и за прогон
  // почти ничего нового не давали (в /diag 3 кандидата на 12 лент). Добавлены
  // частые научные и русскоязычные ленты; вживую отсюда не проверены — /diag
  // и /probe покажут, какие отвечают.
  'https://phys.org/rss-feed/',
  'https://www.sciencealert.com/feed',
  'https://www.livescience.com/feeds/all',
  'https://newatlas.com/index.rss',
  'https://www.earth.com/feed/',
  'https://nplus1.ru/rss',
  'https://naked-science.ru/feed',
  'https://www.popmech.ru/out/public-all.xml',
];
// Мировых лент за прогон — не все сразу, по кругу: Free-план даёт 50
// подзапросов на вызов, и каждая лента — это подзапрос, отнятый у LLM.
// 16 лент по 8 — каждая раз в 6 часов при кроне раз в 3 часа.
const GLOBAL_FEEDS_PER_RUN = 8;

// Казахстанские ленты для местных эхо. Как и DEFAULT_SOURCES, отсюда вживую не
// проверены — смотрим /diag после деплоя (fetched=0 у мёртвой ленты).
const DEFAULT_LOCAL_SOURCES = [
  'https://tengrinews.kz/news.rss',
  'https://kaz.tengrinews.kz/news.rss',
  'https://www.inform.kz/rss/rus.xml',   // Kazinform
  'https://www.qonaev-gorod.kz/news',    // городской сайт Конаева, RSS нет — читается со страницы
];
// Сайты, у которых ВСЁ — про Конаев и область: их записи не проверяются на
// упоминание места (в заголовке городского сайта «Конаев» обычно не пишут),
// а модели сообщается, что источник местный. Остальные проверки те же.
const LOCAL_HOSTS = ['qonaev-gorod.kz'];
// Места Конаева и области (ru и kk, корни — падежи ловятся сами). Алматы-город
// сюда намеренно не входит: он отдельная единица и заслонил бы область.
const LOCAL_WORDS = ['конаев', 'қонаев', 'капшагай', 'капчагай', 'қапшағай', 'алматинск', 'алматы облыс',
  'талгар', 'талғар', 'есик', 'есік', 'иссык', 'каскелен', 'қаскелең', 'илийск', 'іле аудан',
  'энбекшиказах', 'еңбекшіқазақ', 'шелек', 'чилик', 'шилік', 'кеген', 'нарынкол', 'нарынқол', 'райымбек',
  'уйгурск', 'ұйғыр аудан', 'чарын', 'шарын', 'кольсай', 'көлсай', 'каинды', 'қайыңды', 'алтын-эмел', 'алтынэмел',
  'алтынемел', 'балхаш', 'балқаш', 'баканас', 'бақанас', 'узынагаш', 'ұзынағаш', 'бурундай', 'боралдай',
  'отеген батыр', 'өтеген батыр', 'жамбылский район', 'карасайск', 'қарасай', 'байсерке', 'тургень', 'түрген'];
const KONAEV = [43.8667, 77.0667];
const LOCAL_RADIUS_KM = 400;      // Алматинская область целиком укладывается
// Алматы-город в 60 км от Конаева и в радиус попадает, но он отдельная единица,
// а не область: всё, что геокодер кладёт ближе ALMATY_KM к его центру, — не местное.
// Городской сайт Конаева пишет и про Алматы (рейсы, концерты) — это отсюда.
const ALMATY = [43.24, 76.95];
const ALMATY_KM = 25;
const LOCAL_PER_RUN = 4;          // местных вызовов LLM за прогон — сверх LLM_PER_RUN_MAX
const LOCAL_KEEP_DAYS = 21;       // местные редки — держим дольше
const LOCAL_MAX = 20;             // столько местных гарантированно остаются в подборке

const KV_PAYLOAD = 'echo';        // то, что отдаётся сайту
const KV_SEEN = 'echo:seen';      // хэши уже разобранных записей (и принятых, и отсеянных)
const KV_LIVE = 'echo:live';      // '1' — владелец в эфире
const KV_LAST = 'echo:last';      // сводка последнего прогона для /diag

const KEEP_DAYS_DEFAULT = 7;
const ITEMS_MAX = 60;             // потолок подборки: сайту за визит нужно три
const SEEN_MAX = 1500;            // хватает на недели лент, JSON — десятки КБ
const FEED_SCAN_MAX = 20;         // сколько свежих записей ленты смотреть за прогон
const PER_HOST_PER_RUN = 3;       // квота на редакцию, как в образце (правка 29.08)
const LLM_PER_RUN_MAX = 16;       // потолок платных вызовов за прогон (без повторов); реально ограничивает бюджет подзапросов
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
— in_region: true, только если событие произошло в городе Конаев или в Алматинской области Казахстана (НЕ в городе Алматы — это отдельный город), иначе false.

Ответь СТРОГО одним JSON без markdown и пояснений:
{"ok":true или false,"political":true или false,"tragic":true или false,"ru":"...","kk":"...","place_en":"..." или null,"place_ru":"..." или null,"place_kk":"..." или null,"body":null,"in_region":false}
Если не годится: {"ok":false,"political":...,"tragic":...}`;

// Добавка к запросу для МЕСТНЫХ новостей: область редко даёт «лёгкие» темы
// (замер 24.09: 4 из 4 местных отклонены — зерновой комплекс, рейды, новый
// аким), поэтому для них допускается городская жизнь. Власть и происшествия —
// нет, как и везде; стоп-листы с акиматами работают поверх.
const LOCAL_RULE = `Это местная новость Конаева или Алматинской области. Для неё, кроме лёгких тем, ГОДИТСЯ и городская жизнь: благоустройство и новые объекты (парки, скверы, школы, детсады, дороги, больницы), праздники, концерты и фестивали, спорт и успехи земляков, погода, природа, туризм и отдых. По-прежнему НЕ годятся: акимы и любые чиновники, назначения, заявления, совещания и отчёты, законы и госпрограммы, выборы, происшествия, рейды, аварии, суды, трагедии. Фразу пиши о самом событии, без упоминания властей.`;

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
  'полици', 'преступ', 'насили', 'религи', 'мечет', 'церк', 'аким', 'маслихат', 'сессии маслихат', 'нур отан', 'аманат'];
const STOP_KK = ['президент', 'премьер', 'министр', 'үкімет', 'парламент', 'мәжіліс', 'сенат', 'депутат', 'сайлау',
  'партия', 'санкция', 'соғыс', 'әскер', 'зымыран', 'шабуыл', 'лаңкес', 'наразылық', 'митинг',
  'қаза', 'өлім', 'өлді', 'қайтыс', 'кісі өлтір', 'апат', 'өрт', 'жер сілкін', 'су тасқын', 'індет',
  'сот', 'қамау', 'полиция', 'қылмыс', 'зорлық', 'дін', 'мешіт', 'шіркеу', 'әкім', 'мәслихат', 'аманат'];
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

function parseLocalSources(env) {
  const raw = (env.ECHO_LOCAL_SOURCES || '').trim();
  if (!raw) return DEFAULT_LOCAL_SOURCES.slice();
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter(Boolean).map(String); // [] — выключено
  } catch (_) { /* список через пробелы */ }
  return raw.split(/\s+/).map(s => s.trim()).filter(Boolean);
}

function localHit(text) {
  const s = ' ' + String(text || '').toLowerCase().replace(/ё/g, 'е') + ' ';
  return LOCAL_WORDS.some(w => s.includes(w.replace(/ё/g, 'е')));
}

function havKm(a, b) {
  const R = 6371, r = Math.PI / 180, dl = (b[0] - a[0]) * r, dg = (b[1] - a[1]) * r;
  const x = Math.sin(dl / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dg / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(x));
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

// Страница новостей без RSS: заголовки берём из ссылок на ней. Берём только
// ссылки того же сайта, ведущие ГЛУБЖЕ адреса страницы (…/news/что-то), с
// текстом длиной с заголовок — так отсекаются меню, теги и «читать далее».
function extractHtmlItems(html, pageUrl) {
  let base;
  try { base = new URL(pageUrl); } catch (e) { return []; }
  const prefix = base.pathname.replace(/\/+$/, '') + '/';
  const seenLinks = new Set(), items = [];
  const re = /<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) && items.length < 60) {
    let u;
    try { u = new URL(decodeEntities(m[1]), base); } catch (e) { continue; }
    if (u.hostname.replace(/^www\./, '') !== base.hostname.replace(/^www\./, '')) continue;
    if (!u.pathname.startsWith(prefix) || u.pathname.length <= prefix.length + 3) continue;
    const title = stripCdata(m[2]);
    if (title.length < 20 || title.length > 220 || !/\p{L}{3}/u.test(title)) continue;
    const link = u.origin + u.pathname;
    if (seenLinks.has(link)) continue;
    seenLinks.add(link);
    items.push({ title, link, desc: '', pub: '' });
  }
  return items;
}

function looksHtml(text, type) {
  return /html/i.test(type || '') || /^\s*<!doctype html|<html[\s>]/i.test(text.slice(0, 500));
}

async function fetchFeed(url) {
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'KonaevEcho/1.0 (+https://konaev.tv)' } });
    if (!r.ok) return { items: [], err: 'http_' + r.status };
    const text = await r.text();
    const items = parseFeedItems(text);
    if (items.length || !looksHtml(text, r.headers.get('content-type'))) return { items };
    return { items: extractHtmlItems(text, url), html: true };
  } catch (e) { return { items: [], err: 'throw: ' + String(e).slice(0, 80) }; }
}

function isLocalHost(url) {
  const h = sourceHost(url);
  return !!h && LOCAL_HOSTS.some(x => h === x || h.endsWith('.' + x));
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
        // Потолок, а не расход. mimo-v2.5 на шлюзе DotPoin тратит часть лимита
        // на рассуждение: при 400 (24.09, первый полный прогон) 8 из 12 ответов
        // пришли пустыми или оборванными на середине JSON. Модель без
        // рассуждения (LLM_MODEL=deepseek-v4-flash-no-reasoner) в него не упирается.
        max_tokens: 1200,
        messages: [
          { role: 'system', content: ECHO_PROMPT },
          { role: 'user', content: (item.local ? LOCAL_RULE + '\n\n' : '') + (item.hint ? item.hint + '\n\n' : '') + `Заголовок: ${item.title}\n\nНачало: ${(item.desc || '').slice(0, DESC_MAX) || '—'}` },
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
    // finish_reason=length — ответ обрезан лимитом: пишем это в причину,
    // чтобы в /diag было видно, что дело в лимите, а не в шлюзе.
    const cut = d?.choices?.[0]?.finish_reason === 'length' ? ' (finish=length)' : '';
    if (!raw) return { fail: 'empty_response' + cut };
    let p;
    try { p = JSON.parse(raw); } catch (e) { return { fail: 'bad_json' + cut + ': ' + raw.slice(0, 60) }; }
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
  return { echo: { ru, kk, place_en: body ? null : cleanPlace(p.place_en), pr: cleanPlace(p.place_ru), pk: cleanPlace(p.place_kk), body, inRegion: p.in_region === true } };
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
  else if (sources.length > GLOBAL_FEEDS_PER_RUN) {
    // окно по кругу: номер трёхчасового слота определяет, с какой ленты начать
    const slot = Math.floor(Date.now() / (3 * 3600000));
    const start = (slot * GLOBAL_FEEDS_PER_RUN) % sources.length;
    sources = sources.concat(sources).slice(start, start + GLOBAL_FEEDS_PER_RUN);
  }
  // Быстрый /run местные ленты не трогает: он проверяет цепочку, а не улов.
  const localSources = opts.maxSources ? [] : parseLocalSources(env);
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
  const feeds = sources.map(url => ({ url, local: false })).concat(localSources.map(url => ({ url, local: true })));
  const fetched = await Promise.all(feeds.map(async ({ url, local }) => {
    const { items, err, html } = await fetchFeed(url);
    const city = local && isLocalHost(url);
    const withIds = [];
    // Общие казахстанские ленты длинные, а местного в них мало — смотрим глубже.
    for (const item of items.slice(0, local ? FEED_SCAN_MAX * 3 : FEED_SCAN_MAX)) {
      if (city) item.hint = 'Источник — городской новостной сайт Конаева: если в тексте не сказано иное, событие в Конаеве или Алматинской области.';
      const id = await hashId(item.link || `${url}|${item.pub || item.title}`);
      withIds.push({ item, id, url, local, city });
    }
    return { url, local, city, html, withIds, err };
  }));
  used += feeds.length;
  const feedsOk = fetched.filter(f => !f.err).length;

  // ФАЗА 2 — отсев без LLM: уже разобранные и то, что режет стоп-лист прямо
  // по заголовку (за такие записи не платим вовсе). Квота на редакцию.
  const byHost = {}, localPool = [];
  let stoppedByTitle = 0;
  for (const f of fetched) {
    for (const x of f.withIds) {
      if (seen.has(x.id)) continue;
      // Местная лента: без упоминания места области запись даже не кандидат
      // (и не в seen — проверка бесплатная, а лента могла дописать описание).
      if (f.local && !f.city && !localHit(x.item.title + ' ' + x.item.desc)) continue;
      if (stopHit(x.item.title, STOP_EN) || stopHit(x.item.title, STOP_RU) || stopHit(x.item.title, STOP_KK)) { seen.add(x.id); stoppedByTitle++; continue; }
      if (f.local) { x.item.local = true; localPool.push(x); continue; }
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
  // Местные — вперёд очереди: их мало, и без них подмешивать на сайте нечего.
  // Одна и та же новость часто есть в нескольких казахстанских лентах, поэтому
  // дубли по заголовку отсекаем до LLM.
  shuffleInPlace(localPool);
  const localTitles = new Set(), localCands = [];
  for (const x of localPool) {
    const key = x.item.title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    if (localTitles.has(key)) continue;
    localTitles.add(key); localCands.push(x);
    if (localCands.length >= LOCAL_PER_RUN) break;
  }
  candidates.unshift(...localCands);
  summary.rejected.stop_title = stoppedByTitle;
  summary.localCandidates = localCands.length;

  // ФАЗА 3 — суд модели, пачками по 4; бюджет проверяется перед пачкой по
  // факту трат (правка образца 22.08). Резерв: 2 попытки + геокод на запись
  // и 3 записи в KV в конце.
  const CONC = 4;
  const judged = [];
  const cap = llmCap + localCands.length; // местные — сверх общего потолка
  for (let i = 0; i < candidates.length && judged.length < cap; i += CONC) {
    if (budgetLeft() < CONC * 3 + 3) break;
    const chunk = candidates.slice(i, Math.min(i + CONC, i + cap - judged.length));
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
    if (r.local && !e.inRegion) { summary.rejected.not_in_region = (summary.rejected.not_in_region || 0) + 1; continue; }
    let ll = null, dist;
    if (e.body) dist = BODIES[e.body];
    else if (e.place_en && budgetLeft() >= 4) { ll = await geocodePlace(e.place_en); used++; }
    // Местное эхо без координат или дальше радиуса — отказ: «рядом» должно
    // быть проверено, а не сказано моделью.
    // С городского сайта без названного места — это сам Конаев.
    if (r.city && e.inRegion && !ll) ll = KONAEV.slice();
    if (r.local && (!ll || havKm(KONAEV, ll) > LOCAL_RADIUS_KM)) { summary.rejected.local_far = (summary.rejected.local_far || 0) + 1; continue; }
    if (r.local && havKm(ALMATY, ll) < ALMATY_KM) { summary.rejected.local_almaty = (summary.rejected.local_almaty || 0) + 1; continue; }
    const it = { id: r.id, ru: e.ru, kk: e.kk, pr: e.pr || '', pk: e.pk || e.pr || '', ll, src: sourceHost(r.url), t: summary.ranAt };
    if (dist) it.dist = dist;
    if (r.local) { it.loc = 1; summary.acceptedLocal = (summary.acceptedLocal || 0) + 1; }
    fresh.push(it);
  }
  summary.accepted = fresh.length;

  // ФАЗА 5 — слить со старыми, выкинуть просроченные, записать. updated
  // двигаем только если прогон реально состоялся: хоть одна лента ответила и
  // шлюз не лёг целиком (все вызовы — сбой). Иначе оставляем старый updated —
  // сайт через 48 ч сам уйдёт на запас (fail-closed по свежести).
  const cutoff = Date.now() - keepDays(env) * 86400000, localCutoff = Date.now() - LOCAL_KEEP_DAYS * 86400000;
  const old = (Array.isArray(payload.items) ? payload.items : []).filter(x => x && Date.parse(x.t) > (x.loc ? localCutoff : cutoff));
  const ids = new Set(fresh.map(x => x.id));
  const all = fresh.concat(old.filter(x => !ids.has(x.id)));
  // Местные не вытесняются потоком мировых: их до LOCAL_MAX, остальное — мировые.
  const locals = all.filter(x => x.loc).slice(0, LOCAL_MAX);
  const items = locals.concat(all.filter(x => !x.loc).slice(0, ITEMS_MAX - locals.length));
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

  summary.sources = fetched.map(f => ({ url: f.url, local: f.local || undefined, html: f.html || undefined, fetched: f.withIds.length, err: f.err || null,
    candidates: candidates.filter(c => c.url === f.url).length }));
  summary.localTotal = locals.length;
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
        // id и t — чтобы сайт помнил, что зритель уже видел, и показывал сначала свежее
        const o = { id: x.id, t: x.t, ru: x.ru, kk: x.kk, pr: x.pr, pk: x.pk, ll: x.ll || null, src: x.src };
        if (x.dist) o.dist = x.dist;
        if (x.loc) o.loc = 1;
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
    if (path === '/probe') {
      // Проверка источника с iPad: что по адресу и что воркер из него достанет.
      const target = url.searchParams.get('url') || '';
      try { new URL(target); } catch (e) { return json({ error: 'нужен параметр url=https://…' }, 400); }
      const out = { url: target };
      try {
        const r = await fetch(target, { headers: { 'User-Agent': 'KonaevEcho/1.0 (+https://konaev.tv)' } });
        const text = await r.text();
        out.status = r.status; out.type = r.headers.get('content-type');
        const rss = parseFeedItems(text);
        out.rssItems = rss.length;
        // Ленты, объявленные на странице (<link rel="alternate" type="…rss/atom…">).
        out.feedsOnPage = Array.from(text.matchAll(/<link[^>]+type=["']application\/(?:rss|atom)\+xml["'][^>]*>/gi))
          .map(m => (m[0].match(/href=["']([^"']+)["']/i) || [])[1]).filter(Boolean)
          .map(h => { try { return new URL(decodeEntities(h), target).href; } catch (e) { return h; } });
        const items = rss.length ? rss : (looksHtml(text, out.type) ? extractHtmlItems(text, target) : []);
        out.mode = rss.length ? 'rss' : (items.length ? 'html' : 'ничего не найдено');
        out.items = items.length;
        out.sample = items.slice(0, 8).map(x => x.title + '  →  ' + x.link);
        out.localMentions = items.filter(x => localHit(x.title + ' ' + x.desc)).length;
      } catch (e) { out.error = String(e).slice(0, 150); }
      return json(out);
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
