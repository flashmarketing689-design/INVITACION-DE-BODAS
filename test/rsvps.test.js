const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const handler = require('../api/rsvps');
const dataFile = path.join(__dirname, '..', 'data', 'rsvps.json');

function createRes() {
  const res = {};
  res.headers = {};
  res.setHeader = (name, value) => {
    res.headers[name] = value;
  };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (payload) => {
    res.body = payload;
    return res;
  };
  res.end = () => {
    res.ended = true;
    return res;
  };
  return res;
}

test('POST and GET persist RSVPs without Supabase env', async () => {
  fs.writeFileSync(dataFile, '[]', 'utf8');

  const postReq = {
    method: 'POST',
    body: {
      nombre: 'Ana Pérez',
      telefono: '809-000-0000',
      asistencia: 'si',
      mensaje: 'Gracias',
      fecha: '2026-07-07T00:00:00.000Z'
    }
  };

  const postRes = createRes();
  await handler(postReq, postRes);

  assert.equal(postRes.statusCode, 200);
  assert.equal(postRes.body.nombre, 'Ana Pérez');

  const getReq = { method: 'GET' };
  const getRes = createRes();
  await handler(getReq, getRes);

  assert.equal(getRes.statusCode, 200);
  assert.ok(Array.isArray(getRes.body));
  assert.equal(getRes.body[0].nombre, 'Ana Pérez');
});
