const previousTeamNames = new Map([
  ["Onyx", "Engineering Team"],
  ["Echo", "Security Team"],
  ["Vanta", "Quality Team"],
]);

export function currentTeamName(name) {
  return previousTeamNames.get(name) ?? name;
}
