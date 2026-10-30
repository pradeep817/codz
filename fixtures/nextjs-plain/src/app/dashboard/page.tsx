import { fetchUser } from "../../services/user-service"

export default async function DashboardPage() {
  const user = await fetchUser("me")
  return <main>{user.name}</main>
}
