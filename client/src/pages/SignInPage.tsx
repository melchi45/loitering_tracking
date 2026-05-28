import { useAuthStore } from '../stores/authStore';

export default function SignInPage() {
  const { error, clearError } = useAuthStore();

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        {/* Logo / Title */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl bg-blue-600 mb-4">
            <svg className="w-9 h-9 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M15 10l4.553-2.069A1 1 0 0121 8.866V15.134a1 1 0 01-1.447.898L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-white">LTS-2026</h1>
          <p className="text-gray-400 text-sm mt-1">Loitering Tracking System</p>
        </div>

        {/* Card */}
        <div className="bg-gray-900 border border-gray-800 rounded-2xl shadow-2xl p-8 space-y-4">
          <p className="text-center text-gray-300 text-sm font-medium mb-2">Sign in to continue</p>

          {/* Error banner */}
          {error && (
            <div className="flex items-start gap-2 p-3 bg-red-900/40 border border-red-700 rounded-lg text-red-300 text-sm">
              <svg className="w-4 h-4 mt-0.5 shrink-0" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
              </svg>
              <span>{error}</span>
              <button onClick={clearError} className="ml-auto text-red-400 hover:text-red-200">&#10005;</button>
            </div>
          )}

          {/* Google */}
          <a
            href="/auth/google"
            className="flex items-center justify-center gap-3 w-full bg-white hover:bg-gray-100 text-gray-800 font-medium py-2.5 px-4 rounded-lg transition-colors shadow-sm"
          >
            {/* Google coloured G logo */}
            <svg className="w-5 h-5 shrink-0" viewBox="0 0 24 24">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/>
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
            </svg>
            Continue with Google
          </a>

          {/* Microsoft */}
          <a
            href="/auth/microsoft"
            className="flex items-center justify-center gap-3 w-full bg-[#2F2F2F] hover:bg-[#404040] text-white font-medium py-2.5 px-4 rounded-lg transition-colors shadow-sm"
          >
            {/* Microsoft 4-square logo */}
            <svg className="w-5 h-5 shrink-0" viewBox="0 0 21 21">
              <rect x="1"  y="1"  width="9" height="9" fill="#F35325"/>
              <rect x="11" y="1"  width="9" height="9" fill="#81BC06"/>
              <rect x="1"  y="11" width="9" height="9" fill="#05A6F0"/>
              <rect x="11" y="11" width="9" height="9" fill="#FFBA08"/>
            </svg>
            Continue with Microsoft
          </a>

          <p className="text-xs text-gray-500 text-center pt-2">
            New accounts require <span className="text-blue-400">administrator approval</span>
          </p>
        </div>
      </div>
    </div>
  );
}
