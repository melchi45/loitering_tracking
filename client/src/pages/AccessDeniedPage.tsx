import { useAuthStore } from '../stores/authStore';
import { useI18n } from '../i18n';

export default function AccessDeniedPage() {
  const auth = useAuthStore();
  const { t } = useI18n();

  return (
    <div className="min-h-screen bg-gray-950 flex items-center justify-center p-4">
      <div className="w-full max-w-sm text-center space-y-6">
        {/* Icon */}
        <div className="inline-flex items-center justify-center w-20 h-20 rounded-full bg-red-900/40 border border-red-700/50">
          <svg className="w-10 h-10 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
              d="M12 15v2m0 0v2m0-2h2m-2 0H10m2-5V9m0 0V7m0 2h2M12 9h-2M4.929 4.929l14.142 14.142M4.929 19.071L19.07 4.93" />
          </svg>
        </div>

        {/* Message */}
        <div>
          <h1 className="text-2xl font-bold text-white mb-2">{t.accessDeniedTitle}</h1>
          <p className="text-gray-400 text-sm leading-relaxed">
            {t.accessDeniedBefore} <span className="text-white font-semibold">Admin</span> {t.accessDeniedAfter}
          </p>
          {auth.user && (
            <p className="text-gray-500 text-xs mt-2">
              {t.accessDeniedCurrentAccount} <span className="text-gray-400">{auth.user.email}</span>
              &nbsp;·&nbsp;
              {t.accessDeniedRole} <span className="capitalize text-yellow-400">{auth.user.role}</span>
            </p>
          )}
        </div>

        {/* Actions */}
        <div className="flex flex-col gap-3">
          <button
            onClick={() => auth.logout()}
            className="w-full py-2.5 px-4 rounded-lg bg-gray-800 hover:bg-gray-700 border border-gray-700 text-gray-200 text-sm font-medium transition-colors"
          >
            {t.accessDeniedSwitchAccount}
          </button>
        </div>
      </div>
    </div>
  );
}
