// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as api from '../../../lib/api/users';
import UserProfilePage from './page';

vi.mock('../../../lib/api/users', async (importOriginal) => ({ ...(await importOriginal<object>()), getUser: vi.fn() }));
const getUserMock = api.getUser as unknown as { mockResolvedValue(value: unknown): unknown; mockRejectedValue(error: unknown): unknown };
const sample = {"id":1,"name":"Sample name 1","email":"user1@example.com"};

describe('UserProfilePage', () => {
  afterEach(() => cleanup());

  it('shows the data', async () => {
    getUserMock.mockResolvedValue(sample);
    render(await UserProfilePage({ params: Promise.resolve({ id: '1' }) } as any));
    expect((await screen.findAllByText("Sample name 1")).length).toBeGreaterThan(0);
  });

  it('throws when the API fails, for error.tsx to show', async () => {
    getUserMock.mockRejectedValue(new Error('boom'));
    await expect(UserProfilePage({ params: Promise.resolve({ id: '1' }) } as any)).rejects.toThrow('boom');
  });
});
