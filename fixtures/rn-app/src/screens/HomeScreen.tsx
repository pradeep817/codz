import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { getJobs } from '../api/jobs';
import type { Job } from '../types/job';

export default function HomeScreen() {
  const [jobs, setJobs] = useState<Job[]>([]);
  useEffect(() => {
    getJobs().then(setJobs);
  }, []);
  return (
    <View>
      <Text>{jobs.length} jobs</Text>
    </View>
  );
}
