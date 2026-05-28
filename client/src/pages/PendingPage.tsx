import { useAuthStore } from '../stores/authStore';

export default function PendingPage() {
  const { user, logout } = useAuthStore();

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center p-4">
      <div className="w-full max-w-md text-center">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-yellow-500/20 mb-6">
          <svg className="w-8 h-8 text-yellow-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>

        <h1 className="text-2xl font-bold text-white mb-2">Awaiting Approval</h1>
        <p className="text-gray-400 mb-6">
          Your account <span className="text-white font-medium">{user?.email}</span> has been created
          and is pending approval from an administrator.
        </p>

        <div className="bg-gray-900 border border-gray-800 rounded-xl p-6 mb-6 text-left space-y-3">
          <div className="flex items-center gap-3 text-sm text-gray-300">
            <span className="w-6 h-6 rounded-full bg-blue-600 text-white flex items-center justify-center text-xs font-bold shrink-0">1</span>
            An admin has been notified of your registration.
          </div>
          <div className="flex items-center gap-3 text-sm text-gray-300">
            <span className="w-6 h-6 rounded-full bg-gray-700 text-gray-400 flex items-center justify-center text-xs font-bold shrink-0">2</span>
            Once approved, you can sign in to access the dashboard.
          </div>
          <div className="flex items-center gap-3 text-sm text-gray-300">
            <span className="w-6 h-6 rounded-full bg-gray-700 text-gray-400 flex items-center justify-center text-xs font-bold shrink-0">3</span>
            Contact your admin if this takes too long.
          </div>
        </div>

        <button
          onClick={() => logout()}
          className="text-sm text-gray-400 hover:text-white transition-colors underline"
        >
          Sign out
        </button>
      </div>
    </div>
  );
}
