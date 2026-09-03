/** @vitest-environment jsdom */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

type Listener = (user: unknown) => void

let currentListener: Listener | null = null
let currentUser: { getIdTokenResult: (force?: boolean) => Promise<{ claims: Record<string, unknown> }> } | null = null

vi.mock('firebase/auth', () => ({
  onAuthStateChanged: (_auth: unknown, cb: Listener) => {
    currentListener = cb
    cb(currentUser)
    return () => {
      currentListener = null
    }
  },
  signInWithEmailAndPassword: vi.fn(async () => {
    currentUser = { getIdTokenResult: async () => ({ claims: { role: 'admin' } }) }
    currentListener?.(currentUser)
  }),
  signOut: vi.fn(async () => {
    currentUser = null
    currentListener?.(null)
  }),
}))

vi.mock('../firebase', () => ({ auth: {} }))

import { AuthProvider, useAuth } from './AuthProvider'

function Probe() {
  const { status, user, signIn, signOutUser } = useAuth()
  return (
    <div>
      <div data-testid="status">{status}</div>
      <div data-testid="uid">{user ? 'has-user' : 'no-user'}</div>
      <button onClick={() => void signIn('a@b.com', 'pw')}>sign in</button>
      <button onClick={() => void signOutUser()}>sign out</button>
    </div>
  )
}

beforeEach(() => {
  currentUser = null
  currentListener = null
})

afterEach(() => {
  cleanup()
})

describe('AuthProvider', () => {
  it('starts signed-out when no user is present', async () => {
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    )
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('signed-out'))
  });

  it('reaches signed-in-admin after a successful admin sign-in', async () => {
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    )
    const user = userEvent.setup()
    await user.click(screen.getByText('sign in'))
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('signed-in-admin'))
    expect(screen.getByTestId('uid').textContent).toBe('has-user')
  });

  it('reaches signed-out again after sign-out', async () => {
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    )
    const user = userEvent.setup()
    await user.click(screen.getByText('sign in'))
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('signed-in-admin'))
    await act(async () => {
      await user.click(screen.getByText('sign out'))
    })
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('signed-out'))
  });

  it('reaches signed-in-non-admin for a non-admin token', async () => {
    currentUser = { getIdTokenResult: async () => ({ claims: { role: 'staff' } }) }
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    )
    await waitFor(() => expect(screen.getByTestId('status').textContent).toBe('signed-in-non-admin'))
  });
})
