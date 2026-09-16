// Tests for the text-message grammar and date/phone helpers.   Run:  npm test
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { parseSms, phoneKey, weekStart, twilioSignatureValid } = require('./board');

let n = 0;
const t = (name, fn) => { fn(); n++; };

t('empty / help', () => {
  assert.equal(parseSms('').action, 'help');
  assert.equal(parseSms('  help ').action, 'help');
  assert.equal(parseSms('?').action, 'help');
  assert.equal(parseSms('#help').action, 'help');
});

t('announcements', () => {
  assert.deepEqual(parseSms('ANNOUNCE Team meeting Friday at 3'), { action: 'announcement', text: 'Team meeting Friday at 3' });
  assert.deepEqual(parseSms('announce: pizza in the break room'), { action: 'announcement', text: 'pizza in the break room' });
  assert.deepEqual(parseSms('Announcement - new hours start Monday'), { action: 'announcement', text: 'new hours start Monday' });
  assert.equal(parseSms('announce').action, 'error');
});

t('no keyword follows the default', () => {
  assert.deepEqual(parseSms('Great job everyone yesterday!'), { action: 'announcement', text: 'Great job everyone yesterday!' });
  assert.deepEqual(parseSms('Great job everyone yesterday!', 'task'), { action: 'task', kind: 'once', text: 'Great job everyone yesterday!' });
  // a message that merely starts with an ordinary word keeps its first word
  assert.equal(parseSms('A big thanks to the closing crew').text, 'A big thanks to the closing crew');
});

t('tasks', () => {
  assert.deepEqual(parseSms('TASK restock the towel bins'), { action: 'task', kind: 'once', text: 'restock the towel bins' });
  assert.deepEqual(parseSms('task: call the vendor'), { action: 'task', kind: 'once', text: 'call the vendor' });
  assert.deepEqual(parseSms('DAILY wipe down the counter'), { action: 'task', kind: 'daily', text: 'wipe down the counter' });
  assert.deepEqual(parseSms('task daily count the drawer'), { action: 'task', kind: 'daily', text: 'count the drawer' });
  assert.deepEqual(parseSms('WEEKLY Fri deep-clean the back room'), { action: 'task', kind: 'weekly', dow: 5, text: 'deep-clean the back room' });
  assert.deepEqual(parseSms('weekly: inventory check'), { action: 'task', kind: 'weekly', dow: null, text: 'inventory check' });
  assert.deepEqual(parseSms('Weekly Monday - submit timesheets'), { action: 'task', kind: 'weekly', dow: 1, text: 'submit timesheets' });
  assert.deepEqual(parseSms('task weekly sat mop the floor'), { action: 'task', kind: 'weekly', dow: 6, text: 'mop the floor' });
  assert.equal(parseSms('task').action, 'error');
  assert.equal(parseSms('weekly fri').action, 'error');
});

t('goals', () => {
  assert.deepEqual(parseSms('GOAL memberships 5'), { action: 'goal', label: 'memberships', target: 5, unit: 'count' });
  assert.deepEqual(parseSms('goal: 8 units'), { action: 'goal', label: 'units', target: 8, unit: 'count' });
  assert.deepEqual(parseSms('GOAL revenue $1,200'), { action: 'goal', label: 'revenue', target: 1200, unit: 'dollars' });
  assert.deepEqual(parseSms('goal add-on sales 350 dollars'), { action: 'goal', label: 'add-on sales', target: 350, unit: 'dollars' });
  assert.deepEqual(parseSms('goal daily revenue 900'), { action: 'goal', label: 'daily revenue', target: 900, unit: 'dollars' });
  assert.equal(parseSms('goal memberships').action, 'error');
  assert.equal(parseSms('goal 5').action, 'error');
});

t('phone keys ignore formatting and the country code', () => {
  assert.equal(phoneKey('+12085550100'), '2085550100');
  assert.equal(phoneKey('(208) 555-0100'), '2085550100');
  assert.equal(phoneKey('208.555.0100'), '2085550100');
  assert.equal(phoneKey(''), '');
});

t('weeks start on Monday', () => {
  assert.equal(weekStart('2026-09-16'), '2026-09-14'); // Wed -> Mon
  assert.equal(weekStart('2026-09-14'), '2026-09-14'); // Mon
  assert.equal(weekStart('2026-09-20'), '2026-09-14'); // Sun belongs to the week before
  assert.equal(weekStart('2026-09-21'), '2026-09-21');
});

t('twilio signature check', () => {
  const token = 'abc123', url = 'https://example.com/api/sms/inbound';
  const params = { From: '+12085550100', Body: 'ANNOUNCE hi', MessageSid: 'SM1' };
  const sig = crypto.createHmac('sha1', token).update(url + 'BodyANNOUNCE hiFrom+12085550100MessageSidSM1').digest('base64');
  assert.equal(twilioSignatureValid(token, url, params, sig), true);
  assert.equal(twilioSignatureValid(token, url, { ...params, Body: 'tampered' }, sig), false);
  assert.equal(twilioSignatureValid(token, url, params, ''), false);
});

console.log(`board.test.js: ${n} groups passed`);
