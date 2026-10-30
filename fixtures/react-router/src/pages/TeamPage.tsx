import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { getTeam } from '../api/teams';
import type { Team } from '../types/team';

export default function TeamPage() {
  const { teamId } = useParams();
  const [team, setTeam] = useState<Team | null>(null);
  useEffect(() => {
    if (teamId) getTeam(teamId).then(setTeam);
  }, [teamId]);
  return <h1>{team?.name}</h1>;
}
