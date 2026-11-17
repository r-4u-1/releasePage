'use strict';
// TEXT REVEAL — goes with text-reveal.css
// The letters of every element with a data-text-reveal attribute rise in one by one,
// then slide into place. All the elements play at the same time.
//
// Use it on any element with plain text:  <h1 data-text-reveal>Create a release page</h1>
// If the hyperspeed intro is on the page, it starts when the intro is done; otherwise right away.
// To turn the effect off, remove this script and text-reveal.css.

(function textReveal() {
  const RISE = { stagger: 52, duration: 580 };  // each letter starts 52 ms after the previous one
  const SLIDE = { stagger: 16, duration: 460 };
  const PAUSE = 52;                             // between rising and sliding

  const elements = [...document.querySelectorAll('[data-text-reveal]')];
  // People who asked their system for less motion see the text as it is.
  if (elements.length === 0 || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  // Splits the element's text into letter spans, grouped by word so lines wrap between words.
  // Screen readers read the aria-label instead of the separate letters.
  function splitIntoLetters(element) {
    const text = element.textContent.trim();
    const letters = [];
    const parts = text.split(/(\s+)/).filter(Boolean).map(part => {
      if (/^\s+$/.test(part)) return document.createTextNode(' ');
      const word = document.createElement('span');
      word.className = 'char-word';
      for (const char of part) {
        const span = document.createElement('span');
        span.className = 'char';
        span.textContent = char;
        word.append(span);
        letters.push(span);
      }
      return word;
    });
    element.setAttribute('aria-label', text);
    element.replaceChildren(...parts);
    for (const part of parts) if (part.nodeType === Node.ELEMENT_NODE) part.setAttribute('aria-hidden', 'true');
    return letters;
  }

  // The letters rise in one by one, then slide into place.
  function animateLetters(letters) {
    const totalTime = ({ stagger, duration }) => (letters.length - 1) * stagger + duration;
    const play = (className, { stagger }) => letters.forEach((span, i) => {
      span.style.animationDelay = `${i * stagger}ms`;
      span.classList.add(className);
    });

    return new Promise(resolve => {
      play('rising', RISE);
      setTimeout(() => {
        letters.forEach(span => { span.style.animationDelay = ''; span.classList.remove('rising'); });
        void letters[0]?.offsetWidth; // lets the slide animation start fresh
        play('sliding', SLIDE);
        setTimeout(() => {
          letters.forEach(span => { span.style.animationDelay = ''; span.classList.replace('sliding', 'done'); });
          resolve();
        }, totalTime(SLIDE));
      }, totalTime(RISE) + PAUSE);
    });
  }

  // Split now, so the letters are hidden behind the intro, not shown and then hidden.
  const letterGroups = elements.map(splitIntoLetters);
  const start = () => letterGroups.forEach(animateLetters);

  // The hyperspeed intro removes its overlay when it's done.
  if (document.getElementById('intro')) window.addEventListener('intro-done', start, { once: true });
  else start();
})();
