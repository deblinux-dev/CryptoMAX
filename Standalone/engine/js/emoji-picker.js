/**
 * Emoji Picker — emoji-mart v5 integration.
 * Shared floating picker for both Encryption (#encryptInput) and
 * Steganography (#carrier-text) tabs.
 *
 * The emoji-mart global is exposed as `emojiMart` by vendor/emoji-mart/emoji-mart.js.
 *
 * IMPORTANT: This module does NOT inject any CSS overrides.
 * The <em-emoji-picker> web component is fully self-contained — it handles
 * its own sizing, scrolling, theme, and layout internally via Shadow DOM.
 * Setting CSS properties (overflow, max-height, width) on the host element
 * BREAKS internal scrolling and category navigation.
 */
;(async function () {
  'use strict';

  // ── References ─────────────────────────────────────────────────
  const encryptInput   = document.getElementById('encryptInput');
  const carrierText    = document.getElementById('carrier-text');
  const btnEncryptEmoji = document.getElementById('btnEncryptEmoji');
  const btnEmojiPicker = document.getElementById('btnEmojiPicker');   // stego tab

  if (!btnEncryptEmoji && !btnEmojiPicker) return;

  // ── Ensure emoji-mart is available ─────────────────────────────
  const emojiMart = window.EmojiMart || window.emojiMart || (window['emoji-mart']);
  if (!emojiMart) {
    console.warn('[emoji-picker] emoji-mart not found — picker disabled');
    return;
  }

  // ── Add minimal CSS for the encrypt emoji row only ─────────────
  // (Everything else is handled by emoji-mart's own Shadow DOM styles)
  const styleEl = document.createElement('style');
  styleEl.textContent = `
    .cm-encrypt-emoji-row {
      display: flex;
      align-items: center;
      margin-bottom: 2px;
    }
  `;
  document.head.appendChild(styleEl);

  // ── Initialize emoji-mart data & i18n ─────────────────────────
  try {
    await emojiMart.init({
      data: async () => await (await fetch('/vendor/emoji-mart/emoji-data.json')).json(),
      i18n: async () => await (await fetch('/vendor/emoji-mart/i18n-ru.json')).json(),
      locale: 'ru',
    });
  } catch (err) {
    console.error('[emoji-picker] emoji-mart init failed:', err);
    return;
  }

  // ── Patch emoji data for Russian search ────────────────────────
  _addRussianSearchKeywords();

  // ── Create picker (single instance, reused) ────────────────────
  // Mounted directly to body — no wrapper div, no CSS overrides.
  // The component is fully self-contained via Shadow DOM.
  const pickerEl = new emojiMart.Picker({
    onEmojiSelect: handleEmojiSelect,
    onClickOutside: handleClickOutside,
    theme: 'dark',
    set: 'native',
    perLine: 8,
    emojiButtonSize: 32,
    emojiSize: 22,
    searchPosition: 'sticky',
    previewPosition: 'none',
    skinTonePosition: 'none',
  });

  // Initially hidden (not appended to DOM yet)
  pickerEl.style.display = 'none';

  // ── State ──────────────────────────────────────────────────────
  let isOpen = false;
  let lastTriggerBtn = null;
  let centeredMode = false;

  /** Determine which textarea to insert into. */
  function getTargetTextarea() {
    if (encryptInput && document.activeElement === encryptInput) return encryptInput;
    if (carrierText && document.activeElement === carrierText) return carrierText;
    if (lastTriggerBtn === btnEncryptEmoji) return encryptInput;
    return carrierText || encryptInput;
  }

  // ── Insert emoji at cursor ─────────────────────────────────────
  function insertEmoji(emoji) {
    const textarea = getTargetTextarea();
    if (!textarea) return;

    const start = textarea.selectionStart;
    const end   = textarea.selectionEnd;
    const value = textarea.value;

    textarea.value = value.slice(0, start) + emoji + value.slice(end);
    const newPos = start + emoji.length;
    textarea.selectionStart = textarea.selectionEnd = newPos;
    textarea.focus();

    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function handleEmojiSelect({ native }) {
    if (!native) return;

    if (window._emojiStegoPickCallback) {
      const consumed = window._emojiStegoPickCallback(native);
      if (consumed) {
        hidePicker();
        return;
      }
    }

    insertEmoji(native);
  }

  // ── onClickOutside callback from emoji-mart ────────────────────
  function handleClickOutside() {
    if (!isOpen) return;
    hidePicker();
  }

  // ── Position picker near the trigger button, always on-screen ──
  function positionNearButton(btn) {
    const rect = btn.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Get picker's actual rendered dimensions
    const pickerW = pickerEl.offsetWidth || 352;
    const pickerH = pickerEl.offsetHeight || 400;
    const gap = 8;

    // Horizontal: center on button, then clamp to viewport
    let left = rect.left + rect.width / 2 - pickerW / 2;
    if (left < 8) left = 8;
    if (left + pickerW > vw - 8) left = vw - pickerW - 8;

    // Vertical: prefer above, then below, always clamp to viewport
    const spaceAbove = rect.top - gap;
    const spaceBelow = vh - rect.bottom - gap;
    let top;

    if (spaceAbove >= pickerH) {
      top = rect.top - pickerH - gap;
    } else if (spaceBelow >= pickerH) {
      top = rect.bottom + gap;
    } else if (spaceAbove >= spaceBelow) {
      top = 8;
    } else {
      top = vh - pickerH - 8;
    }

    if (top < 8) top = 8;
    if (top + pickerH > vh - 8) top = vh - pickerH - 8;

    pickerEl.style.left = left + 'px';
    pickerEl.style.top  = top + 'px';
    pickerEl.style.transform = '';
  }

  // ── Position picker centered on screen ─────────────────────────
  function positionCentered() {
    pickerEl.style.left = '50%';
    pickerEl.style.top  = '50%';
    pickerEl.style.transform = 'translate(-50%, -50%)';
  }

  // ── Show / Hide ────────────────────────────────────────────────
  function showPicker(btn, centered = false) {
    lastTriggerBtn = btn;
    centeredMode = centered;
    isOpen = true;

    // Mount to body if not already
    if (!pickerEl.parentNode) {
      document.body.appendChild(pickerEl);
    }

    // Apply fixed positioning
    pickerEl.style.position = 'fixed';
    pickerEl.style.zIndex = '1000';
    pickerEl.style.display = '';
    pickerEl.style.transform = '';

    if (centered) {
      positionCentered();
    } else {
      // Use requestAnimationFrame so the browser has computed
      // the picker's natural dimensions before we measure them
      requestAnimationFrame(() => positionNearButton(btn));
    }

    // Highlight active button
    if (btnEncryptEmoji) btnEncryptEmoji.classList.toggle('active', btn === btnEncryptEmoji);
    if (btnEmojiPicker)  btnEmojiPicker.classList.toggle('active', btn === btnEmojiPicker);
  }

  function hidePicker() {
    isOpen = false;
    centeredMode = false;
    pickerEl.style.display = 'none';
    pickerEl.style.transform = '';
    lastTriggerBtn = null;
    if (btnEncryptEmoji) btnEncryptEmoji.classList.remove('active');
    if (btnEmojiPicker)  btnEmojiPicker.classList.remove('active');
  }

  function togglePicker(btn, centered = false) {
    if (isOpen && lastTriggerBtn === btn) {
      hidePicker();
    } else {
      showPicker(btn, centered);
    }
  }

  // ── Public API for Emojistego to open picker centered ──────────
  window._openEmojiPickerCentered = function() {
    const stegoPickerBtn = document.getElementById('btnEmojiPicker');
    if (stegoPickerBtn) {
      togglePicker(stegoPickerBtn, true);
    }
  };

  // ── Button event listeners ─────────────────────────────────────
  if (btnEncryptEmoji) {
    btnEncryptEmoji.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      togglePicker(btnEncryptEmoji, false);
    });
  }

  if (btnEmojiPicker) {
    btnEmojiPicker.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      togglePicker(btnEmojiPicker, false);
    });
  }

  // ── Close on Escape ────────────────────────────────────────────
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && isOpen) {
      hidePicker();
      const ta = getTargetTextarea();
      if (ta) ta.focus();
    }
  });

  // ── Reposition on scroll / resize (only for non-centered mode) ─
  let repositionTimer;
  function scheduleReposition() {
    if (!isOpen || !lastTriggerBtn || centeredMode) return;
    clearTimeout(repositionTimer);
    repositionTimer = setTimeout(() => positionNearButton(lastTriggerBtn), 50);
  }
  window.addEventListener('resize', scheduleReposition);
  const inputArea = document.querySelector('.cm-input-area');
  if (inputArea) inputArea.addEventListener('scroll', scheduleReposition);

  // ── Russian search keyword patch ───────────────────────────────
  function _addRussianSearchKeywords() {
    try {
      const data = emojiMart.Data;
      if (!data || !data.emojis) {
        console.warn('[emoji-picker] Cannot access emoji data for Russian search patch');
        return;
      }

      const ruKeywords = {
        'grinning': 'улыбка', 'smiley': 'улыбающееся', 'smile': 'улыбка',
        'grin': 'оскал', 'laughing': 'смеющийся смех хохот', 'wink': 'подмигивание',
        'blush': 'румянец стеснение', 'heart_eyes': 'влюбленный', 'kissing_heart': 'поцелуй',
        'stuck_out_tongue': 'язык', 'stuck_out_tongue_winking_eye': 'подмигивание язык',
        'joy': 'радость слёзы счастье', 'sob': 'плач рыдание', 'scream': 'крик ужас',
        'disappointed': 'разочарование', 'unamused': 'недовольный', 'weary': 'усталость',
        'sunglasses': 'очки солнцезащитные', 'heart': 'сердце любовь',
        'broken_heart': 'разбитое сердце', 'kiss': 'поцелуй', 'thinking': 'думающий',
        'face_with_raised_eyebrow': 'бровь', 'neutral_face': 'нейтральный',
        'expressionless': 'безразличный', 'confused': 'путаница', 'worried': 'беспокойство',
        'fearful': 'страх', 'angry': 'злость гнев', 'rage': 'ярость бешенство',
        'triumph': 'триумф', 'cry': 'плач', 'clown': 'клоун', 'ghost': 'призрак',
        'skull': 'череп', 'alien': 'инопланетянин', 'robot': 'робот', 'poop': 'какашка куча',
        'smirk': 'ухмылка', 'rolling_eyes': 'закатывание глаз', 'nerd': 'ботан очкарик',
        'star_struck': 'звезда', 'woozy': 'опьянение', 'hot': 'жарко', 'cold': 'холодно',
        'wave': 'привет прощание', 'thumbsup': 'палец вверх лайк одобрение',
        'thumbsdown': 'палец вниз дизлайк', 'clap': 'хлопок аплодисменты',
        'pray': 'молитва пожалуйста', 'handshake': 'рукопожатие',
        'ok_hand': 'ок нормально', 'vulcan_salute': 'спок', 'point_up': 'указание палец',
        'crossed_fingers': 'скрестить пальцы удача', 'fist': 'кулак', 'punch': 'удар кулак',
        'raised_hand': 'рука поднятая', 'speak_no_evil': 'обезьяна не слышу',
        'see_no_evil': 'обезьяна не вижу', 'hear_no_evil': 'обезьяна не слушаю',
        'writing_hand': 'письмо', 'call_me': 'позвони', 'muscle': 'мышца сила',
        'dog': 'собака', 'cat': 'кот кошка', 'mouse': 'мышь', 'hamster': 'хомяк',
        'rabbit': 'кролик', 'fox': 'лиса', 'bear': 'медведь', 'panda': 'панда',
        'koala': 'коала', 'tiger': 'тигр', 'lion': 'лев', 'cow': 'корова',
        'pig': 'свинья', 'frog': 'лягушка', 'monkey': 'обезьяна', 'chicken': 'курица',
        'penguin': 'пингвин', 'bird': 'птица', 'duck': 'утка', 'eagle': 'орёл',
        'butterfly': 'бабочка', 'bug': 'жук насекомое', 'ant': 'муравей',
        'bee': 'пчела', 'spider': 'паук', 'scorpion': 'скорпион', 'snake': 'змея',
        'turtle': 'черепаха', 'fish': 'рыба', 'dolphin': 'дельфин', 'whale': 'кит',
        'shark': 'акула', 'octopus': 'осьминог', 'shell': 'ракушка', 'snail': 'улитка',
        'flower': 'цветок', 'rose': 'роза', 'bouquet': 'букет',
        'cherry_blossom': 'сакура', 'sunflower': 'подсолнух', 'seedling': 'росток',
        'evergreen_tree': 'ёлка дерево', 'deciduous_tree': 'дерево', 'palm_tree': 'пальма',
        'cactus': 'кактус', 'mushroom': 'гриб', 'earth_americas': 'земля',
        'earth_africa': 'земля', 'earth_asia': 'земля', 'full_moon': 'луна',
        'sun': 'солнце', 'cloud': 'облако', 'rainbow': 'радуга', 'umbrella': 'зонт',
        'snowflake': 'снежинка', 'fire': 'огонь', 'droplet': 'капля вода',
        'comet': 'комета', 'star': 'звезда', 'sparkles': 'искры волшебство',
        'zap': 'молния',
        'apple': 'яблоко', 'pear': 'груша', 'tangerine': 'мандарин', 'lemon': 'лимон',
        'banana': 'банан', 'watermelon': 'арбуз', 'grapes': 'виноград',
        'strawberry': 'клубника', 'cherries': 'вишня', 'peach': 'персик',
        'pineapple': 'ананас', 'avocado': 'авокадо', 'broccoli': 'брокколи',
        'carrot': 'морковь', 'corn': 'кукуруза', 'hot_pepper': 'перец острый',
        'cucumber': 'огурец', 'tomato': 'помидор', 'egg': 'яйцо', 'milk': 'молоко',
        'cheese': 'сыр', 'bread': 'хлеб', 'croissant': 'круассан',
        'pancakes': 'блины', 'hamburger': 'бургер гамбургер',
        'french_fries': 'картофель фри', 'pizza': 'пицца',
        'hotdog': 'хот-дог сосиска', 'sandwich': 'бутерброд', 'taco': 'тако',
        'burrito': 'бурито', 'sushi': 'суши', 'shrimp': 'креветка',
        'ice_cream': 'мороженое', 'cake': 'торт', 'birthday': 'день рождения',
        'cookie': 'печенье', 'chocolate_bar': 'шоколад', 'candy': 'конфета',
        'popcorn': 'попкорн', 'coffee': 'кофе', 'tea': 'чай', 'beer': 'пиво',
        'wine_glass': 'вино', 'cocktail': 'коктейль', 'champagne': 'шампанское',
        'house': 'дом', 'school': 'школа', 'office': 'офис',
        'hospital': 'больница', 'bank': 'банк', 'hotel': 'отель',
        'church': 'церковь', 'car': 'машина автомобиль', 'taxi': 'такси',
        'bus': 'автобус', 'truck': 'грузовик', 'bicycle': 'велосипед',
        'airplane': 'самолёт авиа', 'rocket': 'ракета', 'ship': 'корабль',
        'train': 'поезд', 'clock': 'часы время', 'phone': 'телефон',
        'computer': 'компьютер', 'keyboard': 'клавиатура', 'camera': 'камера фото',
        'television': 'телевизор', 'radio': 'радио', 'microphone': 'микрофон',
        'headphones': 'наушники', 'musical_note': 'нота музыка', 'guitar': 'гитара',
        'money': 'деньги', 'dollar': 'доллар', 'gift': 'подарок',
        'book': 'книга', 'notebook': 'тетрадь блокнот', 'pencil': 'карандаш',
        'pen': 'ручка', 'lock': 'замок', 'key': 'ключ',
        'hammer': 'молоток', 'wrench': 'гаечный ключ', 'bulb': 'лампочка идея',
        'bomb': 'бомба', 'knife': 'нож', 'shield': 'щит', 'compass': 'компас',
        'globe': 'глобус мир', 'map': 'карта', 'mountain': 'гора',
        'fireworks': 'фейерверк салют', 'soccer': 'футбол',
        'basketball': 'баскетбол', 'tennis': 'теннис',
        'family': 'семья', 'couple': 'пара', 'dancer': 'танцовщица танец',
        'baby': 'младенец ребёнок', 'boy': 'мальчик', 'girl': 'девочка',
        'man': 'мужчина', 'woman': 'женщина', 'police_officer': 'полиция полицейский',
        'detective': 'детектив сыщик', 'ninja': 'ниндзя',
        'construction_worker': 'строитель', 'prince': 'принц',
        'princess': 'принцесса', 'bride_with_veil': 'невеста свадьба',
        'superhero': 'супергерой', 'mage': 'маг волшебник', 'fairy': 'фея',
        'vampire': 'вампир', 'mermaid': 'русалка', 'elf': 'эльф',
        'zombie': 'зомби', 'santa': 'дед мороз',
        'check': 'галочка да', 'warning': 'предупреждение',
        'peace': 'мир', 'flag-russia': 'россия русский',
        'flag-us': 'америка сша', 'flag-uk': 'британия',
        'flag-japan': 'япония', 'flag-china': 'китай',
      };

      for (const [id, ruWords] of Object.entries(ruKeywords)) {
        const emoji = data.emojis[id];
        if (emoji && emoji.search) {
          emoji.search += ',' + ruWords.toLowerCase();
        }
      }

      if (emojiMart.SearchIndex) {
        emojiMart.SearchIndex.reset();
      }

      console.log('[emoji-picker] Russian search keywords patched (' + Object.keys(ruKeywords).length + ' emojis)');
    } catch (err) {
      console.warn('[emoji-picker] Failed to patch Russian keywords:', err);
    }
  }

})();
