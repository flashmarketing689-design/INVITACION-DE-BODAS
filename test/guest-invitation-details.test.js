const test = require('node:test');
const assert = require('node:assert/strict');
const { guestInvitationDetails } = require('../lib/guestInvitationDetails');

test('datos de invitación agrupan por id, conservando personas de ambos novios y categorías', () => {
  const rows = [
    { id: 1, nombre: 'Ana Pérez', pertenece: 'novia', categoria: 'familiares', invitation_id: 'group-1', invitation_type: 'couple', cantidad_personas: 1 },
    { id: 2, nombre: 'Luis Cruz', pertenece: 'novio', categoria: 'amigos', invitation_id: 'group-1', invitation_type: 'couple', cantidad_personas: 1 },
    { id: 3, nombre: 'Ana Pérez', invitation_id: 'group-2', invitation_type: 'individual', cantidad_personas: 1 },
    { id: 4, nombre: 'Persona Legacy', cantidad_personas: 3 },
    { id: 5, nombre: 'Otra Persona', cantidad_personas: 1 },
  ];
  const output = guestInvitationDetails(rows);
  assert.equal(output.length, rows.length);
  assert.equal(output[0].invitation_member_count, 2);
  assert.equal(output[0].invitation_people_count, 2);
  assert.deepEqual(output[0].invitation_members, [{ id: 1, nombre: 'Ana Pérez' }, { id: 2, nombre: 'Luis Cruz' }]);
  assert.deepEqual(output[1].invitation_members, output[0].invitation_members);
  assert.equal(output[2].invitation_member_count, 1, 'nombres repetidos no mezclan invitaciones');
  assert.equal(output[3].invitation_people_count, 3);
  assert.equal(output[3].invitation_member_count, 1, 'cupos antiguos no inventan integrantes');
  assert.equal(output[4].invitation_member_count, 1, 'registros sin invitación no forman un grupo');
  assert.equal(rows[0].invitation_members, undefined, 'no modifica los registros originales');
});

test('datos de invitación conservan todos los integrantes de familias y soportan lista vacía', () => {
  const family = guestInvitationDetails(Array.from({ length: 5 }, (_, index) => ({
    id: index + 1, nombre: `Persona ${index + 1}`, invitation_id: 'family', invitation_type: 'family', cantidad_personas: 1,
  })));
  assert.ok(family.every((person) => person.invitation_people_count === 5 && person.invitation_members.length === 5));
  assert.deepEqual(guestInvitationDetails([]), []);
});
