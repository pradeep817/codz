import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createNativeStackNavigator } from '@react-navigation/native-stack';

import { useAuth } from '../auth/AuthContext';
import LoadingView from '../components/LoadingView';
import HomeScreen from '../screens/HomeScreen';
import LoginScreen from '../screens/LoginScreen';
import ProfileScreen from '../screens/ProfileScreen';

/**
 * Every screen and its parameters. devtool route add and screen add add entries here, and new
 * screens become tabs; move a Tab.Screen into the Stack below to push it over the tabs instead.
 */
export type RootStackParamList = {
  Login: undefined;
  Tabs: undefined;
  Home: undefined;
  Profile: undefined;
};

const Stack = createNativeStackNavigator<RootStackParamList>();
const Tab = createBottomTabNavigator<RootStackParamList>();

function Tabs() {
  return (
    <Tab.Navigator>
      <Tab.Screen name="Home" component={HomeScreen} options={{ title: '{{appTitle}}' }} />
      <Tab.Screen name="Profile" component={ProfileScreen} />
    </Tab.Navigator>
  );
}

/** Signed out: the login screen. Signed in: the tabs, with other screens pushed on top of them. */
export default function RootNavigator() {
  const { status } = useAuth();
  if (status === 'loading') return <LoadingView />;
  return (
    <Stack.Navigator>
      {status === 'signedOut' ? (
        <Stack.Screen name="Login" component={LoginScreen} options={{ headerShown: false }} />
      ) : (
        <Stack.Screen name="Tabs" component={Tabs} options={{ headerShown: false }} />
      )}
    </Stack.Navigator>
  );
}
