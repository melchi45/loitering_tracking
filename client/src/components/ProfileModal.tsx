import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useAuthStore } from '../stores/authStore';

interface Props {
  onClose: () => void;
}

const MAX_AVATAR_BYTES = 65536; // ~48 KB base64

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export default function ProfileModal({ onClose }: Props) {
  const user          = useAuthStore(s => s.user);
  const updateProfile = useAuthStore(s => s.updateProfile);

  const [name,         setName]         = useState(user?.name         ?? '');
  const [organization, setOrganization] = useState(user?.organization ?? '');
  const [phone,        setPhone]        = useState(user?.phone        ?? '');
  const [bio,          setBio]          = useState(user?.bio          ?? '');
  const [avatar,       setAvatar]       = useState<string | undefined>(user?.avatarDataUrl);
  const [avatarError,  setAvatarError]  = useState<string | null>(null);
  const [saving,       setSaving]       = useState(false);
  const [saveError,    setSaveError]    = useState<string | null>(null);
  const [saved,        setSaved]        = useState(false);

  const fileRef = useRef<HTMLInputElement>(null);

  /* ---- dirty check ---- */
  const isDirty =
    name !== (user?.name ?? '') ||
    organization !== (user?.organization ?? '') ||
    phone !== (user?.phone ?? '') ||
    bio !== (user?.bio ?? '') ||
    avatar !== user?.avatarDataUrl;

  /* ---- clipboard paste ---- */
  const handlePaste = useCallback(async (e: ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (!file) return;
        await processImageFile(file);
        return;
      }
    }
  }, []);

  useEffect(() => {
    document.addEventListener('paste', handlePaste);
    return () => document.removeEventListener('paste', handlePaste);
  }, [handlePaste]);

  /* ---- image validation / set ---- */
  async function processImageFile(file: File) {
    setAvatarError(null);
    if (!file.type.startsWith('image/')) {
      setAvatarError('Please select an image file (JPEG, PNG, GIF, WebP).');
      return;
    }
    const dataUrl = await fileToDataUrl(file);
    if (dataUrl.length > MAX_AVATAR_BYTES) {
      setAvatarError('Image is too large (max ~48 KB). Please choose a smaller image.');
      return;
    }
    setAvatar(dataUrl);
  }

  /* ---- file picker ---- */
  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    await processImageFile(file);
    e.target.value = '';
  }

  /* ---- save ---- */
  async function handleSave() {
    if (!name.trim()) {
      setSaveError('Display name is required.');
      return;
    }
    setSaving(true);
    setSaveError(null);
    try {
      await updateProfile({ name: name.trim(), organization, phone, bio, avatarDataUrl: avatar });
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (err: unknown) {
      setSaveError(err instanceof Error ? err.message : 'Save failed.');
    } finally {
      setSaving(false);
    }
  }

  /* ---- close guard ---- */
  function handleClose() {
    if (isDirty && !saved) {
      if (!window.confirm('You have unsaved changes. Discard and close?')) return;
    }
    onClose();
  }

  /* ---- ESC key ---- */
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') handleClose(); }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={e => { if (e.target === e.currentTarget) handleClose(); }}
    >
      <div className="relative bg-white dark:bg-gray-900 rounded-2xl shadow-2xl w-full max-w-md mx-4 p-6 flex flex-col gap-5">

        {/* Header */}
        <div className="flex items-center justify-between">
          <h2 className="text-xl font-semibold text-gray-900 dark:text-white">Edit Profile</h2>
          <button
            onClick={handleClose}
            className="text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 text-2xl leading-none"
            aria-label="Close"
          >×</button>
        </div>

        {/* Avatar */}
        <div className="flex flex-col items-center gap-3">
          <div
            className="relative w-24 h-24 rounded-full overflow-hidden bg-gray-200 dark:bg-gray-700 flex items-center justify-center cursor-pointer border-2 border-dashed border-gray-300 dark:border-gray-500 hover:border-blue-500 transition-colors"
            title="Click to choose a file, or paste an image from clipboard"
            onClick={() => fileRef.current?.click()}
          >
            {avatar
              ? <img src={avatar} alt="avatar" className="w-full h-full object-cover" />
              : <span className="text-gray-400 text-sm text-center px-2 select-none">Photo</span>
            }
          </div>
          <div className="flex gap-2 text-sm">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="px-3 py-1 rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition-colors"
            >
              Choose file
            </button>
            {avatar && (
              <button
                type="button"
                onClick={() => setAvatar(undefined)}
                className="px-3 py-1 rounded-lg bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-red-100 dark:hover:bg-red-900 transition-colors"
              >
                Remove
              </button>
            )}
          </div>
          <p className="text-xs text-gray-400">Or paste an image from clipboard (Ctrl+V / ⌘V)</p>
          {avatarError && <p className="text-xs text-red-500">{avatarError}</p>}
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={handleFileChange}
          />
        </div>

        {/* Fields */}
        <div className="flex flex-col gap-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Display Name <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              maxLength={64}
              className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="Your name"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Organization / 소속</label>
            <input
              type="text"
              value={organization}
              onChange={e => setOrganization(e.target.value)}
              maxLength={128}
              className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="Company or department"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Phone / 연락처</label>
            <input
              type="text"
              value={phone}
              onChange={e => setPhone(e.target.value)}
              maxLength={32}
              className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="+82-10-0000-0000"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Bio</label>
            <textarea
              value={bio}
              onChange={e => setBio(e.target.value)}
              maxLength={256}
              rows={3}
              className="w-full px-3 py-2 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
              placeholder="Short description about yourself"
            />
            <p className="text-xs text-gray-400 text-right mt-0.5">{bio.length}/256</p>
          </div>
        </div>

        {/* Error / success */}
        {saveError && <p className="text-sm text-red-500 text-center">{saveError}</p>}
        {saved     && <p className="text-sm text-green-600 text-center font-medium">Profile saved!</p>}

        {/* Footer */}
        <div className="flex gap-3 pt-1">
          <button
            type="button"
            onClick={handleClose}
            className="flex-1 px-4 py-2 rounded-lg border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || !name.trim()}
            className="flex-1 px-4 py-2 rounded-lg bg-blue-600 text-white font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
