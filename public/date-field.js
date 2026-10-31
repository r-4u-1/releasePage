'use strict';

(function dateField() {
  const input = $('eventdate'), popup = $('cal-pop'), button = $('date-btn');
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
                  'July', 'August', 'September', 'October', 'November', 'December'];
  const today = new Date();
  let shown = { year: today.getFullYear(), month: today.getMonth() };

  const isoDate = (y, m, d) => `${String(y).padStart(4, '0')}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const ISO = /^\d{4}-\d{2}-\d{2}$/;

  function checkDate() {
    const value = input.value.trim();
    if (!value) return showNeutral('eventdate');
    if (!ISO.test(value)) return showError('eventdate', 'Format must be YYYY-MM-DD');
    const [y, m, d] = value.split('-').map(Number);
    const date = new Date(y, m - 1, d);
    const real = date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d;
    if (!real || y < 1900 || y > 2100) return showError('eventdate', 'Please enter a valid date');
    showValid('eventdate');
  }

  input.addEventListener('input', () => {
    const digits = input.value.replace(/\D/g, '').slice(0, 8);
    const masked = [digits.slice(0, 4), digits.slice(4, 6), digits.slice(6)].filter(Boolean).join('-');
    if (input.value !== masked) {
      input.value = masked;
      input.setSelectionRange(masked.length, masked.length);
    }
    if (masked.length < 10) showNeutral('eventdate');
    else checkDate();
  });
  input.addEventListener('blur', () => { if (input.value.trim()) checkDate(); });

  function dayButton(year, month, day, otherMonth) {
    const date = new Date(year, month, day);
    const value = isoDate(date.getFullYear(), date.getMonth(), date.getDate());
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'cal-day';
    button.textContent = date.getDate();
    if (otherMonth) button.classList.add('dim');
    if (value === isoDate(today.getFullYear(), today.getMonth(), today.getDate())) button.classList.add('today');
    if (value === input.value.trim()) button.classList.add('sel');
    button.addEventListener('click', () => {
      input.value = value;
      setFilled(input);
      checkDate();
      closeCalendar();
      input.focus();
    });
    return button;
  }

  function render() {
    const { year, month } = shown;
    $('cal-lbl').textContent = `${MONTHS[month]} ${year}`;
    const leading = (new Date(year, month, 1).getDay() + 6) % 7;
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const daysInPrevious = new Date(year, month, 0).getDate();
    const trailing = (7 - (leading + daysInMonth) % 7) % 7;

    const buttons = [];
    for (let i = leading - 1; i >= 0; i--) buttons.push(dayButton(year, month - 1, daysInPrevious - i, true));
    for (let d = 1; d <= daysInMonth; d++) buttons.push(dayButton(year, month, d, false));
    for (let d = 1; d <= trailing; d++) buttons.push(dayButton(year, month + 1, d, true));
    $('cal-days').replaceChildren(...buttons);
  }

  function showMonth(year, month) {
    shown = { year: year + Math.floor(month / 12), month: (month + 12) % 12 };
    render();
  }

  function openCalendar() {
    if (ISO.test(input.value)) {
      const [y, m] = input.value.split('-').map(Number);
      shown = { year: y, month: m - 1 };
    } else {
      shown = { year: today.getFullYear(), month: today.getMonth() };
    }
    render();
    popup.hidden = false;
    button.setAttribute('aria-expanded', 'true');
  }

  function closeCalendar() {
    popup.hidden = true;
    button.setAttribute('aria-expanded', 'false');
  }

  const onClick = (id, action) => $(id).addEventListener('click', event => { event.preventDefault(); action(event); });
  onClick('date-btn', event => { event.stopPropagation(); popup.hidden ? openCalendar() : closeCalendar(); });
  onClick('cal-prev', () => showMonth(shown.year, shown.month - 1));
  onClick('cal-next', () => showMonth(shown.year, shown.month + 1));
  onClick('cal-lbl', () => showMonth(today.getFullYear(), today.getMonth()));
  onClick('cal-today', () => showMonth(today.getFullYear(), today.getMonth()));
  document.addEventListener('click', event => { if (!$('f-eventdate').contains(event.target)) closeCalendar(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') closeCalendar(); });
})();
