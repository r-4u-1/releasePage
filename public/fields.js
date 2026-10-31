'use strict';
// Small helpers for the form's fields: finding elements and showing each field's state.
// Loaded before date-field.js and form.js, which use them.

const $ = id => document.getElementById(id);

/* ═══════════════════════════════════════════════════════════════════════════
   FIELD STATES
   Plain fields: is-valid (green check) or has-error (red message).
═══════════════════════════════════════════════════════════════════════════ */

// A field with a value keeps its label floated above it.
function setFilled(input) {
  input.closest('.field')?.classList.toggle('filled', input.value.trim() !== '');
}
document.querySelectorAll('input, select').forEach(input => {
  input.addEventListener('input', () => setFilled(input));
  input.addEventListener('change', () => setFilled(input));
});

function showValid(id) {
  $('f-' + id).classList.remove('has-error');
  $('f-' + id).classList.add('is-valid');
  $('e-' + id).textContent = '';
}

function showError(id, message) {
  $('f-' + id).classList.remove('is-valid');
  $('f-' + id).classList.add('has-error');
  $('e-' + id).textContent = message;
}

function showNeutral(id) {
  $('f-' + id).classList.remove('has-error', 'is-valid');
  $('e-' + id).textContent = '';
}
