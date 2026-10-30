export interface User {
  id: string
  name: string
}

export interface Team {
  id: string
  title: string
}

export interface Member {
  id: string
  name: string
  role: string
}

export interface TeamDetail {
  id: string
  title: string
  members: Member[]
  /** ISO 8601 date string. */
  created_at: string
  // codz: type unknown from the samples; set it by hand.
  archived_at?: unknown
}
