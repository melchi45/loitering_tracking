'use strict';

/**
 * RBAC middleware — checks req.user.role is in the allowed roles list.
 * Must be used AFTER verifyAccessToken.
 *
 * Usage:  router.get('/admin/users', verifyAccessToken, requireRole('admin'), handler)
 *         router.get('/data',        verifyAccessToken, requireRole('admin','operator'), handler)
 */
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Unauthenticated' });
    if (!roles.includes(req.user.role))
      return res.status(403).json({ error: 'Insufficient role', required: roles });
    next();
  };
}

module.exports = { requireRole };
