'use strict';

// URL веб-приложения Apps Script: Развернуть → Управление развёртываниями → URL (оканчивается на /exec).
const API_URL = 'https://script.google.com/macros/s/AKfycbyBQ8r6YgfJx961dyweGuk86FREVGXWeCkSH4xVKIv2IujY6bfRbcL1W2Hov5QlB6Uy/exec';

const tg = window.Telegram && window.Telegram.WebApp;
const IN_TG = !!(tg && tg.initData);
// Telegram передаёт данные пользователя в адресе страницы. Если они есть, а скрипт Telegram не загрузился,
// это сбой загрузки, а не обычный браузер, — демо-данные в этом случае не показываем.
const OPENED_IN_TG = IN_TG || /tgWebAppData=/.test(location.hash);
const DEMO = !OPENED_IN_TG; // вне Telegram показываем демо-данные, чтобы можно было посмотреть интерфейс
const REQUEST_TIMEOUT_MS = 20000;
const CART_KEY = 'cart_v1';
const PAGE_SIZE = 25; // столько товаров рисуем сразу, остальные — по мере прокрутки

const state = {
  tab: 'catalog', // 'catalog' | 'discounts' | 'cart'
  screen: null, // 'register' | 'restore' | 'restore-sent' | 'success' | null
  loading: true,
  loadError: null,
  busy: false,
  shop: { name: 'Айпарк', currency: '₽', policyUrl: '' },
  categories: [], // [{ name, group }]
  products: [],
  discounts: [], // по программам скидок: [{ name, discount, spent, title, levels, next, manual, active }]
  profile: null,
  activeCategory: null,
  visible: PAGE_SIZE,
  cart: loadCart(),
  comment: '',
  lastOrder: null,
  form: { name: '', phone: '', email: '', consent: true, contact: null, errors: {} },
  restore: { contact: '', comment: '', errors: {} },
};

const $view = document.getElementById('view');
let lazyObserver = null;
// Готовые карточки товаров: при смене категории переставляем их, а не создаём заново —
// так фото не перезагружаются.
const cardCache = new Map();

// ───────────── API ─────────────

async function api(action, payload) {
  if (DEMO) return demoApi(action, payload || {});
  if (!IN_TG) throw new Error('Не удалось связаться с Telegram. Закрой приложение и открой снова.');
  // Запуск можно безопасно повторить: если сервер не ответил или ответил ошибкой сети, пробуем ещё раз.
  const attempts = action === 'init' ? 2 : 1;
  let data;
  for (let i = 1; i <= attempts; i++) {
    try {
      data = await fetchJson(Object.assign({ action, initData: tg.initData }, payload));
      break;
    } catch (err) {
      if (i === attempts) throw new Error('Не получилось загрузить данные. Проверь интернет и попробуй ещё раз.');
    }
  }
  if (!data.ok) {
    const err = new Error(data.error || 'Что-то пошло не так');
    err.code = data.code;
    throw err;
  }
  return data;
}

/** POST с ограничением по времени: зависший запрос не держит приложение бесконечно. */
async function fetchJson(body) {
  const ctrl = window.AbortController ? new AbortController() : null;
  const timer = ctrl && setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      // text/plain — «простой» запрос без CORS-preflight, который Apps Script не поддерживает
      body: JSON.stringify(body),
      signal: ctrl ? ctrl.signal : undefined,
    });
    return await res.json();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Сначала показываем сохранённую с прошлого раза копию магазина — мгновенно,
 * а свежие данные с сервера подменяют её, как только придут.
 */
async function load() {
  let cached = null;
  try {
    cached = readInitCache();
    if (cached) applyInit(cached);
  } catch (err) {
    cached = null; // сохранённая копия оказалась битой — просто ждём сервер
  }
  state.loading = !cached;
  state.loadError = null;
  render();
  try {
    const data = await api('init');
    applyInit(data);
    writeInitCache(data);
  } catch (err) {
    if (!cached) state.loadError = err.message;
  }
  state.loading = false;
  // Не перерисовываем открытую форму, чтобы не сбить ввод.
  if (state.screen !== 'register' && state.screen !== 'restore') render();
  else updateDock();
}

function initCacheKey() {
  return `init_v1_${tgUser().id}`;
}

function readInitCache() {
  if (DEMO) return null;
  try {
    return JSON.parse(localStorage.getItem(initCacheKey()));
  } catch (err) {
    return null;
  }
}

function writeInitCache(data) {
  if (DEMO) return;
  try {
    localStorage.setItem(initCacheKey(), JSON.stringify(data));
  } catch (err) {
    // Хранилище недоступно — в следующий раз просто подождём сервер.
  }
}

function applyInit(data) {
  state.shop = data.shop;
  state.categories = data.categories;
  state.products = data.products;
  state.discounts = data.discounts;
  state.profile = data.profile;
  if (state.activeCategory && !state.categories.some(c => c.name === state.activeCategory)) state.activeCategory = null;

  // Товары, которых больше нет, убираем из корзины, количество — не больше остатка.
  Object.keys(state.cart).forEach(id => {
    const p = productById(id);
    if (!p) delete state.cart[id];
    else if (p.stock !== null && p.stock !== undefined && state.cart[id] > p.stock) state.cart[id] = p.stock;
  });
  saveCart();
}

// ───────────── Корзина и скидки ─────────────

function loadCart() {
  try {
    return JSON.parse(localStorage.getItem(CART_KEY)) || {};
  } catch (err) {
    return {};
  }
}

function saveCart() {
  try {
    localStorage.setItem(CART_KEY, JSON.stringify(state.cart));
  } catch (err) {
    // Хранилище недоступно — корзина просто не переживёт перезапуск.
  }
}

function productById(id) {
  return state.products.find(p => p.id === id);
}

/** Скидка текущего клиента в программе; до регистрации цены без скидки. */
function groupDiscount(group) {
  if (!state.profile || !group) return 0;
  const d = state.discounts.find(x => x.name === group);
  return d ? d.discount : 0;
}

function categoryDiscount(category) {
  const c = state.categories.find(x => x.name === category);
  return c ? groupDiscount(c.group) : 0;
}

function stockOf(id) {
  const p = productById(id);
  return p && p.stock !== null && p.stock !== undefined ? p.stock : 999;
}

function setQty(id, qty) {
  if (qty > stockOf(id)) {
    toast(`Больше нет — в наличии ${stockOf(id)} шт.`);
    qty = stockOf(id);
  }
  if (qty > 0) state.cart[id] = Math.min(qty, 999);
  else delete state.cart[id];
  saveCart();
  haptic();
}

function cartLines() {
  return Object.keys(state.cart).map(id => {
    const p = productById(id);
    if (!p) return null;
    const qty = state.cart[id];
    const discount = groupDiscount(p.group);
    const sum = round2(p.price * qty);
    return { p, qty, discount, sum, total: discountedPrice(sum, discount) };
  }).filter(Boolean);
}

function cartTotals(lines) {
  const subtotal = round2(lines.reduce((s, l) => s + l.sum, 0));
  const total = round2(lines.reduce((s, l) => s + l.total, 0));
  return { count: lines.reduce((s, l) => s + l.qty, 0), subtotal, discount: round2(subtotal - total), total };
}

// ───────────── Отрисовка ─────────────

function render() {
  const home = state.tab === 'catalog' && !state.screen;
  document.getElementById('shop-title').textContent = state.profile
    ? `Привет, ${state.profile.nick || state.profile.name}!`
    : `Добро пожаловать в ${state.shop.name}`;
  document.querySelector('.top').hidden = !home; // приветствие — только на главной
  document.getElementById('demo-banner').hidden = !DEMO || !home;

  if (state.loading) $view.innerHTML = '<div class="loading"><div class="spinner"></div><p>Загружаем магазин…</p></div>';
  else if (state.loadError) $view.innerHTML = viewError();
  else if (state.screen === 'register') $view.innerHTML = viewRegister();
  else if (state.screen === 'restore') $view.innerHTML = viewRestore();
  else if (state.screen === 'restore-sent') $view.innerHTML = viewRestoreSent();
  else if (state.screen === 'success') $view.innerHTML = viewSuccess();
  else if (state.tab === 'discounts') $view.innerHTML = viewDiscounts();
  else if (state.tab === 'cart') $view.innerHTML = viewCart();
  else $view.innerHTML = viewCatalog();

  setupLazyLoad();
  updateDock();
  updateBackButton();
}

/** Пустое состояние: объёмная иконка, текст и (необязательно) кнопка; fill — по центру экрана. */
function emptyState(art, text, action, fill) {
  return `<div class="empty ${fill ? 'empty-fill' : ''}">
    <img class="state-art" src="img/${art}.jpg" alt="" width="132" height="132">
    <p>${esc(text)}</p>
    ${action || ''}
  </div>`;
}

function viewError() {
  return `<div class="empty">
    <div class="empty-icon">${icon('alert', 'r', 32)}</div>
    <p>${esc(state.loadError)}</p>
    <button class="btn btn-primary" data-action="reload">Попробовать снова</button>
  </div>`;
}

// ── Каталог ──

function filteredProducts() {
  return state.products.filter(p => !state.activeCategory || p.category === state.activeCategory);
}

function viewCatalog() {
  const list = filteredProducts();
  return `
    ${discountBlock()}
    ${state.products.length ? `
      <div class="chips">
        ${chip(null, 'Все')}
        ${state.categories.map(c => chip(c.name, c.name)).join('')}
      </div>
      <div class="grid" id="grid"></div>
      ${list.length > state.visible ? '<div id="more" class="more" aria-hidden="true"><div class="spinner spinner-sm"></div></div>' : ''}`
    : emptyState('empty-box', 'Товары скоро появятся')}`;
}

/** Кладёт в сетку карточки товаров, переиспользуя уже созданные. */
function appendCards(products) {
  const grid = document.getElementById('grid');
  if (!grid) return;
  const frag = document.createDocumentFragment();
  products.forEach((p, i) => {
    const d = groupDiscount(p.group);
    const key = [p.id, d, p.name, p.price, p.photo, p.label, p.stock].join('|');
    let node = cardCache.get(key);
    if (!node) {
      const tmp = document.createElement('div');
      tmp.innerHTML = productCard(p, grid.children.length + i < 6);
      node = tmp.firstElementChild;
      cardCache.set(key, node);
    } else {
      node.querySelector('.ctrl').innerHTML = qtyControl(p.id);
    }
    frag.appendChild(node);
  });
  grid.appendChild(frag);
  // Картинка могла загрузиться, пока карточка была вне страницы, — тогда событие load уже прошло.
  grid.querySelectorAll('.card-img img:not(.loaded)').forEach(img => {
    if (img.complete && img.naturalWidth) img.classList.add('loaded');
    else if (img.complete) img.remove();
  });
}

/** Подгружает следующие товары, когда пользователь докрутил до конца списка. */
function setupLazyLoad() {
  if (lazyObserver) lazyObserver.disconnect();
  if (document.getElementById('grid')) appendCards(filteredProducts().slice(0, state.visible));
  const more = document.getElementById('more');
  if (!more || !('IntersectionObserver' in window)) return;
  lazyObserver = new IntersectionObserver(entries => {
    if (!entries.some(e => e.isIntersecting)) return;
    const list = filteredProducts();
    const next = list.slice(state.visible, state.visible + PAGE_SIZE);
    state.visible += next.length;
    appendCards(next);
    if (state.visible >= list.length) {
      lazyObserver.disconnect();
      more.remove();
    }
  }, { rootMargin: '600px 0px' });
  lazyObserver.observe(more);
}

/** Блок скидки над товарами: приглашение для новичка или приветствие для клиента. */
function discountBlock() {
  if (!state.profile) {
    return `<button class="dblock dblock-cta" data-action="register">
      <img class="dblock-art" src="img/discount-coin.jpg" alt="" width="80" height="80">
      <span class="dblock-body">
        <span class="dblock-title">Зарегистрируйся и&nbsp;сразу получи скидку</span>
        <span class="long-arrow" aria-hidden="true"><i></i>${icon('chevron', 's', 18)}</span>
      </span>
    </button>`;
  }

  // Есть скидка: крупные проценты по программам, по тапу — вкладка «Мои скидки».
  const active = state.discounts.filter(d => (d.active || d.manual) && d.discount > 0);
  // Цвета частей — как у плиток в «Моих скидках»: первая программа тёмная, вторая лаймовая.
  const tone = d => (state.discounts.filter(x => x.active || x.manual).indexOf(d) % 2 ? 'tone-lime' : 'tone-forest');
  return `<button class="dsplit" data-action="tab" data-value="discounts" aria-label="Мои скидки">
    ${active.length
      ? active.map(d => `<span class="dpart ${tone(d)}"><b>−${d.discount}%</b><span>на все ${esc(lower(d.name))}</span></span>`).join('')
      : '<span class="dpart tone-forest"><span>Скидка появится после первой покупки</span></span>'}
  </button>`;
}

function chip(value, label) {
  const pressed = state.activeCategory === value;
  return `<button class="chip" data-action="category" data-value="${esc(value || '')}" aria-pressed="${pressed}">${esc(label)}</button>`;
}

function productCard(p, eager) {
  const d = groupDiscount(p.group);
  return `<article class="card" data-card="${esc(p.id)}">
    <div class="card-img">
      ${icon(productIcon(p), 'r', 44)}
      ${p.photo ? `<img src="${esc(p.photo)}" alt="" loading="${eager ? 'eager' : 'lazy'}" decoding="async">` : ''}
      ${p.label ? `<span class="label ${p.label === 'NEW' ? 'label-new' : 'label-used'}">${esc(p.label)}</span>` : ''}
    </div>
    <div class="card-body">
      <h3>${esc(p.name)}</h3>
      <div class="price">${priceHtml(p.price, d)}</div>
      <div class="ctrl">${qtyControl(p.id)}</div>
    </div>
  </article>`;
}

/** Кнопка на карточке: положить в корзину, а если товар уже там — перейти к заказу. Количество меняется в корзине. */
function qtyControl(id) {
  if (!state.cart[id]) {
    return `<button class="btn btn-icon" data-action="inc" data-id="${esc(id)}" aria-label="В корзину">${icon('cart', 's', 20)}</button>`;
  }
  return `<button class="btn btn-primary" data-action="tab" data-value="cart">К заказу ${icon('arrow', 's', 18)}</button>`;
}

function stepper(id, qty) {
  return `<div class="stepper">
    <button data-action="dec" data-id="${esc(id)}" aria-label="Убрать одну штуку">${icon('minus', 's', 18)}</button>
    <span>${qty}</span>
    <button data-action="inc" data-id="${esc(id)}" aria-label="Добавить ещё одну" ${qty >= stockOf(id) ? 'disabled' : ''}>${icon('plus', 's', 18)}</button>
  </div>`;
}

function priceHtml(price, discount) {
  if (!discount) return `<b>${money(price)}</b>`;
  return `<s>${money(price)}</s><b>${money(discountedPrice(price, discount))}</b>`;
}

// ── Корзина ──

function viewCart() {
  const lines = cartLines();
  if (!lines.length) {
    return emptyState('empty-box', 'В корзине пока пусто',
      '<button class="btn btn-primary" data-action="tab" data-value="catalog">Перейти в каталог</button>', true);
  }
  const t = cartTotals(lines);
  return `
    ${state.profile ? '' : `<button class="tip" data-action="register">
      <img src="img/tip-bulb.jpg" alt="" width="48" height="48">
      <span>Чтобы оформить заказ со скидкой, зарегистрируйся.</span>${icon('chevron', 's', 18)}
    </button>`}
    <h2 class="page-title">Корзина</h2>
    <ul class="lines">${lines.map(lineHtml).join('')}</ul>
    <section class="panel summary">
      <div class="row"><span>Товары, ${t.count} шт.</span><span>${money(t.subtotal)}</span></div>
      ${t.discount > 0 ? `<div class="row save"><span>Твоя скидка</span><span>−${money(t.discount)}</span></div>` : ''}
      <div class="row total"><span>Итого</span><span>${money(t.total)}</span></div>
    </section>
    <label class="field">
      <span>Комментарий к заказу</span>
      <textarea id="comment" rows="3" maxlength="500" placeholder="Цвет, объём памяти, удобное время для связи">${esc(state.comment)}</textarea>
    </label>`;
}

function lineHtml(l) {
  return `<li class="line">
    <div class="line-thumb">
      ${icon(productIcon(l.p), 'r', 26)}
      ${l.p.photo ? `<img src="${esc(l.p.photo)}" alt="" loading="lazy">` : ''}
    </div>
    <div class="line-info">
      <div class="line-name">${esc(l.p.name)}</div>
      <div class="line-meta">${l.discount ? `<span class="save">−${l.discount}%</span>` : esc(l.p.category)}</div>
      <div class="line-bottom">
        ${stepper(l.p.id, l.qty)}
        <div class="line-price">${l.discount ? `<s>${money(l.sum)}</s>` : ''}<b>${money(l.total)}</b></div>
      </div>
    </div>
  </li>`;
}

// ── Мои скидки: бенто из виджетов ──

function viewDiscounts() {
  // Пока скидки нет — пустое состояние с приглашением, без виджетов.
  if (!state.profile) {
    return emptyState('discount-coin-light', 'Зарегистрируйся и сразу получи скидку',
      '<button class="btn btn-primary" data-action="register">Зарегистрироваться</button>', true);
  }
  const programs = state.discounts.filter(d => d.active || d.manual);
  if (!programs.length) return '<p class="hint">Уровни скидок скоро появятся.</p>';
  const odd = programs.length % 2 === 1;
  return `
    <h2 class="page-title">Мои скидки</h2>
    <div class="bento">
      ${programs.map((d, i) => percentTile(d, i, odd && i === programs.length - 1)).join('')}
      ${programs.map((d, i) => scaleTile(d, i)).join('')}
    </div>
    <ul class="rules">
      <li>Скидки на ${esc(joinAnd(programs.map(d => lower(d.name))))} считаются отдельно: каждая покупка идёт в свою шкалу.</li>
      <li>Сумма засчитывается, когда заказ подтверждён.</li>
      <li>Скидка растёт сама, как только наберёшь сумму следующего уровня.</li>
      <li>Скидки применяются, когда товар добавлен в корзину.</li>
    </ul>`;
}

/** Виджет «Скидка на …»: крупный процент. */
function percentTile(d, i, wide) {
  const registered = !!state.profile;
  let value = d.discount;
  let note;
  if (!registered) {
    if (d.discount) note = 'сразу после регистрации';
    else { value = maxDiscount(d); note = 'растёт с покупками'; }
  } else if (d.manual) {
    note = 'персональная';
  } else if (d.title) {
    note = `${icon('crown', 'm', 14)}${esc(d.title)}`;
  } else {
    note = '';
  }
  const art = programArt(d.name);
  return `<article class="tile tile-pct ${i % 2 ? 'tone-lime' : 'tone-forest'} ${wide ? 'tile-wide' : ''}">
    <div class="tile-top">
      <p class="tile-value">${value}<span>%</span></p>
      ${art ? `<img class="tile-art" src="img/${art}.jpg" alt="" width="64" height="64">` : ''}
    </div>
    <p class="tile-label">на ${esc(lower(d.name))}</p>
    ${note ? `<p class="tile-note">${note}</p>` : ''}
  </article>`;
}

/** Виджет-шкала: сколько потрачено и сколько осталось до следующего порога. */
function scaleTile(d, i) {
  const registered = !!state.profile;
  const spent = registered ? d.spent : 0;
  const levels = d.levels.length ? d.levels : [{ threshold: 0, discount: d.discount, title: '' }];
  const max = Math.max(...levels.map(l => l.threshold), 1);
  const ratio = Math.min(1, spent / max);

  const TICKS = 40;
  // Деления порогов и заполнение считаем по одной сетке, чтобы набранный порог был закрашен.
  const filled = spent > 0 ? Math.round(ratio * (TICKS - 1)) + 1 : 0;
  const marks = levels.map(l => Math.round((l.threshold / max) * (TICKS - 1)));
  const bars = Array.from({ length: TICKS }, (_, i) =>
    `<i class="${i < filled ? 'on' : ''} ${marks.indexOf(i) >= 0 ? 'mark' : ''}"></i>`).join('');

  const labels = levels.map(l => {
    const pos = (l.threshold / max) * 100;
    const align = pos <= 0 ? 'start' : pos >= 100 ? 'end' : 'mid';
    const reached = registered && l.threshold <= spent;
    return `<span class="scale-label ${align} ${reached ? 'reached' : ''}" style="left:${pos}%">
      <b>${l.discount}%</b>${l.threshold ? shortMoney(l.threshold) : 'старт'}
    </span>`;
  }).join('');

  let footer;
  if (!registered) footer = 'Шкала начнёт заполняться после регистрации';
  else if (d.manual) footer = `Персональная скидка ${d.discount}%`;
  else if (d.next) footer = `Ещё <b>${money(d.next.left)}</b> — и скидка ${d.next.discount}%${d.next.title ? ` · ${esc(d.next.title)}` : ''}`;
  else footer = 'Максимальная скидка уже твоя';

  return `<article class="tile tile-wide tile-scale">
    <div class="tile-head">
      <p class="tile-label"><span class="tile-icon ${i % 2 ? 'tone-lime' : 'tone-forest'}">${icon(programIcon(d.name), 'm', 16)}</span>Потрачено на ${esc(lower(d.name))}</p>
      <p class="tile-amount">${money(spent)}</p>
    </div>
    <div class="scale" role="img" aria-label="Потрачено ${money(spent)} из ${money(max)}">${bars}</div>
    <div class="scale-labels">${labels}</div>
    <p class="tile-footer">${footer}</p>
  </article>`;
}

// ── Регистрация и восстановление ──

function viewRegister() {
  const f = state.form;
  const err = k => (f.errors[k] ? `<p class="error">${esc(f.errors[k])}</p>` : '');
  const policy = state.shop.policyUrl ? ` (<a href="${esc(state.shop.policyUrl)}" data-action="link">политика</a>)` : '';
  return `<button class="backbtn" data-action="back">${icon('back', 'm', 20)}Назад</button>
  <section class="panel">
    <h2>Регистрация</h2>
    <p class="muted">Сразу выдадим скидку</p>

    <label class="field"><span>Имя</span>
      <input id="f-name" autocomplete="name" value="${esc(f.name)}"></label>
    ${err('name')}

    ${phoneField()}
    ${err('phone')}

    <label class="field"><span>Email (необязательно)</span>
      <input id="f-email" type="email" inputmode="email" autocomplete="email" placeholder="name@example.com" value="${esc(f.email)}"></label>
    ${err('email')}

    <label class="switch-row">
      <span>Согласие на обработку персональных данных${policy}</span>
      <input id="f-consent" class="switch" type="checkbox" role="switch" ${f.consent ? 'checked' : ''}>
    </label>
    ${err('consent')}

    <div class="form-actions">
      <button class="btn btn-primary" data-action="submit-register" ${state.busy || !registerReady() ? 'disabled' : ''}>${state.busy ? 'Регистрируем…' : 'Зарегистрироваться'}</button>
      <button class="linkbtn" data-action="restore">${icon('restore', 'm', 18)}Уже покупали у нас?</button>
    </div>
  </section>`;
}

function viewRestore() {
  const r = state.restore;
  const err = k => (r.errors[k] ? `<p class="error">${esc(r.errors[k])}</p>` : '');
  return `<button class="backbtn" data-action="back">${icon('back', 'm', 20)}Назад</button>
  <section class="panel">
    <h2>Уже покупали у нас?</h2>

    <label class="field"><span>Телефон или ник в Telegram</span>
      <input id="r-contact" autocomplete="tel" placeholder="+7 900 123-45-67 или @ник" value="${esc(r.contact)}"></label>
    ${err('contact')}

    <label class="field"><span>Предыдущие покупки</span>
      <textarea id="r-comment" rows="4" maxlength="500" placeholder="Например: iPhone 15 в марте, ещё чехол и стекло">${esc(r.comment)}</textarea>
      <small class="field-hint">Напиши, что и когда покупал. Мы найдём историю, и скидка появится, когда ты снова откроешь магазин.</small></label>
    ${err('comment')}

    <div class="form-actions">
      <button class="btn btn-primary" data-action="submit-restore" ${state.busy || !restoreReady() ? 'disabled' : ''}>${state.busy ? 'Отправляем…' : 'Отправить'}</button>
    </div>
  </section>`;
}

function viewRestoreSent() {
  return `<section class="success">
    <img class="state-art" src="img/sent-plane.jpg" alt="" width="132" height="132">
    <h2>Заявка отправлена</h2>
    <p>Мы проверим историю покупок и вернём скидку. Она появится, когда ты снова откроешь магазин.</p>
    <button class="btn btn-primary" data-action="tab" data-value="catalog">Вернуться в каталог</button>
  </section>`;
}

function phoneField() {
  const f = state.form;
  const canShare = IN_TG && tg.isVersionAtLeast('6.9');
  return `<label class="field"><span>Телефон</span>
      <input id="f-phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="+7 900 123-45-67" value="${esc(f.phone)}" ${f.contact ? 'readonly' : ''}></label>
    ${f.contact ? `<p class="ok">${icon('check', 'm', 16)}Номер подтверждён в Telegram</p>` : ''}
    ${canShare && !f.contact ? `<div class="field"><button type="button" class="btn" data-action="share-phone">${icon('call', 's', 18)}Взять номер из Telegram</button></div>` : ''}`;
}

function viewSuccess() {
  const o = state.lastOrder;
  return `<section class="success">
    <img class="state-art" src="img/done-check.jpg" alt="" width="132" height="132">
    <h2>Заказ №${o.no} принят</h2>
    <p>Мы свяжемся с тобой в Telegram, чтобы подтвердить заказ.</p>
    <div class="panel">
      ${o.lines.map(l => `<div class="row"><span>${esc(l.name)} × ${l.qty}</span><span>${money(l.total)}</span></div>`).join('')}
      ${o.discount > 0 ? `<div class="row save"><span>Твоя экономия</span><span>−${money(o.discount)}</span></div>` : ''}
      <div class="row total"><span>Итого</span><span>${money(o.total)}</span></div>
    </div>
    <button class="btn btn-primary" data-action="tab" data-value="catalog">Вернуться в каталог</button>
  </section>`;
}

// ───────────── Нижняя панель ─────────────

/**
 * Слева — вкладки «Каталог» (дом) и «Мои скидки» (%), справа — круглая корзина со счётчиком.
 * На вкладке корзины кнопка вытягивается в «Заказать».
 */
function updateDock() {
  document.querySelectorAll('.dock-tab').forEach(t => {
    if (t.dataset.tab === state.tab && !state.screen) t.setAttribute('aria-current', 'page');
    else t.removeAttribute('aria-current');
  });

  const count = cartTotals(cartLines()).count;
  const ordering = state.tab === 'cart' && !state.screen && count > 0 && !state.loading;
  const cart = document.getElementById('dock-cart');
  cart.classList.toggle('is-order', ordering);
  cart.classList.toggle('is-current', state.tab === 'cart' && !state.screen && !ordering);
  cart.disabled = ordering && state.busy;
  cart.setAttribute('aria-label', ordering ? 'Заказать' : `Корзина${count ? `, товаров: ${count}` : ''}`);
  document.getElementById('dock-cart-label').textContent = ordering ? (state.busy ? 'Отправляем…' : 'Заказать') : '';

  const badge = document.getElementById('cart-count');
  badge.hidden = !count || ordering;
  badge.textContent = count;
}

function onDockCart() {
  if (state.tab === 'cart' && !state.screen) {
    if (cartTotals(cartLines()).count) submitOrder();
    return;
  }
  openTab('cart');
}

function updateBackButton() {
  if (!IN_TG || !tg.BackButton) return;
  if (state.screen === 'register' || state.screen === 'restore') tg.BackButton.show();
  else tg.BackButton.hide();
}

function goBack() {
  if (state.screen === 'restore') openScreen('register');
  else openTab(state.tab);
}

// ───────────── Действия ─────────────

function openTab(tab) {
  state.tab = tab;
  state.screen = null;
  render();
  window.scrollTo(0, 0);
}

function openScreen(screen) {
  state.screen = screen;
  render();
  window.scrollTo(0, 0);
}

function openRegister() {
  const user = tgUser();
  if (!state.form.name) state.form.name = [user.first_name, user.last_name].filter(Boolean).join(' ');
  state.form.errors = {};
  openScreen('register');
}

function sharePhone() {
  tg.requestContact((shared, res) => {
    if (!shared) return;
    const contact = res && res.responseUnsafe && res.responseUnsafe.contact;
    if (contact && contact.phone_number) {
      state.form.phone = '+' + String(contact.phone_number).replace(/\D/g, '');
      state.form.contact = res.response;
      state.form.errors.phone = null;
      render();
      updateFormButtons();
    } else {
      toast('Номер отправлен боту. Введи его в поле вручную.');
    }
  });
}

function requestWriteAccess() {
  return new Promise(resolve => {
    if (!IN_TG || !tg.isVersionAtLeast('6.9')) return resolve(false);
    tg.requestWriteAccess(granted => resolve(granted));
  });
}

function phoneError(phone) {
  return phone.replace(/\D/g, '').length < 10 ? 'Укажи телефон полностью, например +7 900 123-45-67' : null;
}

// Кнопки отправки неактивны, пока не заполнено обязательное.
function contactValid(v) {
  const c = v.trim();
  return c.replace(/\D/g, '').length >= 10 || /^@?[A-Za-z][A-Za-z0-9_]{3,31}$/.test(c);
}

function registerReady() {
  const f = state.form;
  return !!f.name.trim() && !phoneError(f.phone) && f.consent;
}

function restoreReady() {
  const r = state.restore;
  return contactValid(r.contact) && r.comment.trim().length >= 3;
}

function updateFormButtons() {
  const reg = $view.querySelector('[data-action="submit-register"]');
  if (reg) reg.disabled = state.busy || !registerReady();
  const res = $view.querySelector('[data-action="submit-restore"]');
  if (res) res.disabled = state.busy || !restoreReady();
}

async function submitRegister() {
  if (state.busy) return;
  const f = state.form;
  f.errors = {};
  if (!f.name.trim()) f.errors.name = 'Укажи имя';
  const pe = phoneError(f.phone);
  if (pe) f.errors.phone = pe;
  if (f.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email.trim())) f.errors.email = 'Проверь email';
  if (!f.consent) f.errors.consent = 'Без согласия мы не сможем сохранить твои данные и выдать скидку';
  if (Object.keys(f.errors).some(k => f.errors[k])) return render();

  // Разрешение писать в личку нужно, чтобы бот прислал подтверждение заказа.
  await requestWriteAccess();

  setBusy(true);
  try {
    const data = await api('register', { name: f.name.trim(), phone: f.phone.trim(), email: f.email.trim(), consent: true, contact: f.contact });
    state.profile = data.profile;
    state.discounts = data.discounts;
    state.screen = null;
    haptic('success');
    toast('Готово! Скидка уже действует');
    window.scrollTo(0, 0);
  } catch (err) {
    alertMessage(err.message);
  }
  setBusy(false);
}

async function submitRestore() {
  if (state.busy) return;
  const r = state.restore;
  r.errors = {};
  const contact = r.contact.trim();
  if (!contactValid(contact)) r.errors.contact = 'Укажи телефон (например, +7 900 123-45-67) или ник в Telegram';
  if (r.comment.trim().length < 3) r.errors.comment = 'Напиши, что ты покупал раньше';
  if (r.errors.contact || r.errors.comment) return render();

  await requestWriteAccess();

  setBusy(true);
  try {
    await api('restore', { contact, name: state.form.name.trim(), comment: r.comment.trim() });
    r.comment = '';
    state.screen = 'restore-sent';
    haptic('success');
  } catch (err) {
    alertMessage(err.message);
  }
  setBusy(false);
  window.scrollTo(0, 0);
}

async function submitOrder() {
  if (state.busy) return;
  // Заказать можно и без регистрации — просто без скидки.
  if (!state.profile) await requestWriteAccess();
  const items = Object.keys(state.cart).map(id => ({ id, qty: state.cart[id] }));
  setBusy(true);
  try {
    const data = await api('order', { items, comment: state.comment.trim() });
    state.lastOrder = data.order;
    state.cart = {};
    state.comment = '';
    saveCart();
    state.screen = 'success';
    haptic('success');
  } catch (err) {
    alertMessage(err.message);
    if (err.code === 'unavailable') await load();
  }
  setBusy(false);
  window.scrollTo(0, 0);
}

function setBusy(busy) {
  state.busy = busy;
  render();
}

$view.addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const { action, id, value } = el.dataset;

  if (action === 'inc' || action === 'dec') {
    setQty(id, (state.cart[id] || 0) + (action === 'inc' ? 1 : -1));
    if (state.tab === 'catalog' && !state.screen) {
      // Перерисовываем только кнопку товара, чтобы не перезагружать картинки.
      const ctrl = $view.querySelector(`[data-card="${cssEscape(id)}"] .ctrl`);
      if (ctrl) ctrl.innerHTML = qtyControl(id);
      updateDock();
    } else {
      render();
    }
  } else if (action === 'category') {
    state.activeCategory = value || null;
    state.visible = PAGE_SIZE;
    render();
  } else if (action === 'tab') {
    openTab(value);
  } else if (action === 'register') {
    openRegister();
  } else if (action === 'restore') {
    state.restore.errors = {};
    if (!state.restore.contact) state.restore.contact = state.form.phone || (tgUser().username ? '@' + tgUser().username : '');
    openScreen('restore');
  } else if (action === 'submit-restore') {
    submitRestore();
  } else if (action === 'back') {
    goBack();
  } else if (action === 'submit-register') {
    submitRegister();
  } else if (action === 'share-phone') {
    sharePhone();
  } else if (action === 'reload') {
    load();
  } else if (action === 'link' && IN_TG) {
    e.preventDefault();
    tg.openLink(el.href);
  }
});

$view.addEventListener('input', e => {
  const t = e.target;
  if (t.id === 'comment') state.comment = t.value;
  else if (t.id === 'f-name') state.form.name = t.value;
  else if (t.id === 'f-phone') state.form.phone = t.value;
  else if (t.id === 'f-email') state.form.email = t.value;
  else if (t.id === 'f-consent') state.form.consent = t.checked;
  else if (t.id === 'r-comment') state.restore.comment = t.value;
  else if (t.id === 'r-contact') state.restore.contact = t.value;
  updateFormButtons();
});
$view.addEventListener('change', e => {
  if (e.target.id === 'f-consent') state.form.consent = e.target.checked;
  updateFormButtons();
});

// Сломанная картинка товара → остаётся иконка-заглушка под ней.
$view.addEventListener('error', e => {
  if (e.target.tagName === 'IMG' && e.target.closest('.card-img, .line-thumb')) e.target.remove();
}, true);
// Загрузившееся фото плавно проявляется поверх заглушки.
$view.addEventListener('load', e => {
  if (e.target.tagName === 'IMG') e.target.classList.add('loaded');
}, true);

document.querySelectorAll('.dock-tab').forEach(t => t.addEventListener('click', () => openTab(t.dataset.tab)));
document.getElementById('dock-cart').addEventListener('click', onDockCart);

// ───────────── Помощники ─────────────

/**
 * SVG-иконка Iconoteka. Толщину подбираем под вес соседнего текста:
 * 'r' — обычный текст (400), 'm' — подписи и вкладки (500), 's' — кнопки (600).
 */
function icon(name, weight, size) {
  const set = ICONS[name];
  const d = set && (set[weight || 'r'] || set.r);
  const px = size || 20;
  return d ? `<svg class="icon" width="${px}" height="${px}" viewBox="0 0 24 24" aria-hidden="true"><path d="${d}" fill="currentColor"/></svg>` : '';
}

/** Иконка-заглушка для товара без фото — по категории и названию. */
function productIcon(p) {
  const text = `${p.category} ${p.name}`.toLowerCase();
  if (/кабел|заряд|адаптер|блок питания|power/.test(text)) return 'cable';
  if (/airpods|наушник|гарнитур|buds/.test(text)) return 'headphones';
  if (/watch|часы|браслет/.test(text)) return 'watch';
  if (/станци|колонк|яндекс/.test(text)) return 'speaker';
  if (/аксессуар|чехол|стекло|плёнк|пленк/.test(text)) return 'tag';
  if (/iphone|samsung|смартфон|телефон|galaxy|pixel|xiaomi|honor/.test(text)) return 'mobile';
  return 'tag';
}

/** Иконка программы скидок для виджетов: аксессуары — наушники, девайсы — телефон. */
/** Объёмная иконка программы для плиток «Моих скидок». */
function programArt(name) {
  return programIcon(name) === 'headphones' ? 'program-accessories' : programIcon(name) === 'mobile' ? 'program-devices' : '';
}

function programIcon(name) {
  const n = name.toLowerCase();
  if (/аксессуар/.test(n)) return 'headphones';
  if (/девайс|устройств|телефон|смартфон|iphone|техник/.test(n)) return 'mobile';
  return 'tag';
}

/** Фирменный светлый фон в шапке Telegram — даже если у пользователя тёмная тема. */
function applyTelegramTheme() {
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  if (tg.isVersionAtLeast('6.1')) {
    tg.setHeaderColor(bg);
    tg.setBackgroundColor(bg);
  }
}

function joinAnd(list) {
  return list.length > 1 ? `${list.slice(0, -1).join(', ')} и ${list[list.length - 1]}` : list.join('');
}

function maxDiscount(d) {
  return d.levels.reduce((m, l) => Math.max(m, l.discount), d.discount);
}

/** «Аксессуары» → «аксессуары» для фраз вида «−10% на аксессуары». */
function lower(name) {
  return name && name[0] !== name[0].toLowerCase() && name.slice(1) === name.slice(1).toLowerCase()
    ? name[0].toLowerCase() + name.slice(1)
    : name;
}

function money(n) {
  const digits = Math.abs(n % 1) > 0.001 ? 2 : 0;
  return new Intl.NumberFormat('ru-RU', { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n) + '\u00a0' + state.shop.currency;
}

/** Короткая подпись для шкалы: 1 500 → «1,5 тыс», 100 000 → «100 тыс». */
function shortMoney(n) {
  if (n < 1000) return money(n);
  return new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 1 }).format(n / 1000) + '\u00a0тыс';
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/** Цена со скидкой, округлённая до целых рублей в пользу покупателя — так же, как на сервере. */
function discountedPrice(sum, discount) {
  return discount ? Math.floor(sum * (1 - discount / 100) + 1e-6) : sum;
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function cssEscape(s) {
  return window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&');
}

function haptic(kind) {
  if (!IN_TG || !tg.HapticFeedback) return;
  if (kind === 'success') tg.HapticFeedback.notificationOccurred('success');
  else tg.HapticFeedback.impactOccurred('light');
}

function alertMessage(text) {
  if (IN_TG && tg.isVersionAtLeast('6.2')) tg.showAlert(text);
  else window.alert(text);
}

let toastTimer;
function toast(text) {
  const el = document.getElementById('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3000);
}

function tgUser() {
  return (IN_TG && tg.initDataUnsafe && tg.initDataUnsafe.user) || DEMO_USER;
}

// ───────────── Демо-режим (вне Telegram) ─────────────

const DEMO_USER = { id: 1, first_name: 'Анна', username: 'anna_demo' };

const demo = {
  registered: false,
  shop: { name: 'Айпарк', currency: '₽', policyUrl: '' },
  programs: [
    { name: 'Аксессуары', levels: [{ threshold: 0, discount: 5, title: '' }, { threshold: 1500, discount: 10, title: '' }, { threshold: 3000, discount: 20, title: '' }, { threshold: 5000, discount: 30, title: 'VIP card' }] },
    { name: 'Девайсы', levels: [{ threshold: 10000, discount: 1, title: '' }, { threshold: 50000, discount: 2, title: '' }, { threshold: 100000, discount: 3, title: '' }] },
  ],
  // История «узнанного» клиента: как в примере из описания для заказчика.
  spent: { 'Аксессуары': 1500, 'Девайсы': 10000 },
  categories: [
    { name: 'iPhone', group: 'Девайсы' },
    { name: 'iPhone б/у', group: 'Девайсы' },
    { name: 'AirPods', group: 'Девайсы' },
    { name: 'Apple Watch', group: 'Девайсы' },
    { name: 'Samsung', group: 'Девайсы' },
    { name: 'Яндекс', group: 'Девайсы' },
    { name: 'Аксессуары', group: 'Аксессуары' },
  ],
  products: [
    { id: 'IP16-128', name: 'iPhone 16 128 ГБ', category: 'iPhone', price: 79990, label: 'NEW', stock: 3 },
    { id: 'IP13-128U', name: 'iPhone 13 128 ГБ, АКБ 89%', category: 'iPhone б/у', price: 34990, label: 'Б/У', stock: 1 },
    { id: 'APP2', name: 'AirPods Pro 2 USB-C', category: 'AirPods', price: 19990, label: 'NEW' },
    { id: 'AWSE2', name: 'Apple Watch SE 2 40 мм', category: 'Apple Watch', price: 24990, label: '' },
    { id: 'SGS24', name: 'Samsung Galaxy S24 256 ГБ', category: 'Samsung', price: 64990, label: '' },
    { id: 'YSM', name: 'Яндекс Станция Мини 3', category: 'Яндекс', price: 7990, label: '' },
    { id: 'CASE16', name: 'Чехол MagSafe для iPhone 16', category: 'Аксессуары', price: 1490, label: '' },
    { id: 'GLASS16', name: 'Защитное стекло iPhone 16', category: 'Аксессуары', price: 790, label: '' },
    { id: 'CHG20', name: 'Зарядка USB-C 20 Вт', category: 'Аксессуары', price: 1990, label: '' },
  ],
  orderNo: 41,
};

// В демо каталог размножен, чтобы было видно подгрузку при прокрутке.
for (let i = 2; i <= 4; i++) {
  demo.products = demo.products.concat(demo.products.slice(0, 9).map(p => Object.assign({}, p, { id: `${p.id}-${i}` })));
}

function demoDiscounts() {
  return demo.programs.map(g => {
    const spent = demo.registered ? demo.spent[g.name] || 0 : 0;
    const discount = g.levels.filter(l => l.threshold <= spent).reduce((m, l) => Math.max(m, l.discount), 0);
    const next = g.levels.find(l => l.threshold > spent && l.discount > discount);
    const level = g.levels.filter(l => l.discount === discount && l.title).pop();
    return {
      name: g.name, active: true, spent, discount, manual: false, title: level ? level.title : '', levels: g.levels,
      next: next ? { threshold: next.threshold, discount: next.discount, title: next.title, left: next.threshold - spent } : null,
    };
  });
}

async function demoApi(action) {
  await new Promise(r => setTimeout(r, 350));
  const groupOf = name => (demo.categories.find(c => c.name === name) || {}).group || '';
  const profile = () => {
    if (!demo.registered) return null;
    const total = Object.keys(demo.spent).reduce((s, k) => s + demo.spent[k], 0);
    return { name: state.form.name || DEMO_USER.first_name, nick: '@' + DEMO_USER.username, phone: state.form.phone, email: state.form.email, totalSpent: total };
  };
  if (action === 'init') {
    return {
      shop: demo.shop,
      categories: demo.categories,
      products: demo.products.map(p => Object.assign({ group: groupOf(p.category), photo: '', stock: null }, p)),
      profile: profile(),
      discounts: demoDiscounts(),
    };
  }
  if (action === 'register') {
    demo.registered = true;
    return { profile: profile(), discounts: demoDiscounts() };
  }
  if (action === 'restore') return {};
  if (action === 'order') {
    const lines = cartLines().map(l => ({ id: l.p.id, name: l.p.name, category: l.p.category, qty: l.qty, price: l.p.price, discount: l.discount, sum: l.sum, total: l.total }));
    const t = cartTotals(cartLines());
    demo.orderNo += 1;
    return { order: { no: demo.orderNo, subtotal: t.subtotal, discount: t.discount, total: t.total, lines } };
  }
  throw new Error('Неизвестное действие');
}

// ───────────── Запуск ─────────────

// Любая неожиданная ошибка — экран «Попробовать снова» вместо пустой страницы.
function showFatal(message) {
  state.loading = false;
  state.loadError = message || 'Что-то пошло не так. Попробуй ещё раз.';
  state.screen = null;
  try {
    render();
  } catch (err) {
    $view.innerHTML = `<div class="empty"><p>${esc(state.loadError)}</p><button class="btn btn-primary" data-action="reload">Попробовать снова</button></div>`;
  }
}
window.addEventListener('error', () => { if (!state.products.length) showFatal(); });
window.addEventListener('unhandledrejection', () => { if (!state.products.length) showFatal(); });

const TAB_ICONS = { catalog: 'home', discounts: 'percent' };
document.querySelectorAll('.dock-tab').forEach(t => { t.innerHTML = icon(TAB_ICONS[t.dataset.tab], 'm', 26); });
document.getElementById('dock-cart-icon').innerHTML = icon('cart', 'm', 26);

if (IN_TG) {
  applyTelegramTheme();
  tg.ready();
  tg.expand();
  tg.MainButton.hide(); // свою нижнюю панель рисуем сами
  if (tg.BackButton) tg.BackButton.onClick(goBack);
}
load().catch(err => showFatal(err && err.message));
