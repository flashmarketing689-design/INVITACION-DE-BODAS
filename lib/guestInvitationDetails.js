// Attach complete invitation membership before the UI filters people.
function guestInvitationDetails(rows) {
  const groups = new Map();
  const key = (guest) => guest.invitation_id ? `invitation:${guest.invitation_id}` : `guest:${guest.id}`;
  for (const guest of rows) {
    const members = groups.get(key(guest)) || [];
    members.push({ id: guest.id, nombre: guest.nombre, cantidad_personas: Number(guest.cantidad_personas) || 1 });
    groups.set(key(guest), members);
  }
  return rows.map((guest) => {
    const members = groups.get(key(guest));
    return { ...guest,
      invitation_member_count: members.length,
      invitation_people_count: members.reduce((total, member) => total + member.cantidad_personas, 0),
      invitation_members: members.map(({ id, nombre }) => ({ id, nombre })),
    };
  });
}
module.exports = { guestInvitationDetails };
