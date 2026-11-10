-- Promote an existing LinkLite account to administrator.
-- In SSMS, replace the email below with the registered account's email.
-- Run only from a trusted SQL Server administrator connection.
-- Never paste a password or password hash into this query.

USE linklite;
GO

DECLARE @email NVARCHAR(254) = N'your-email@example.com';

UPDATE dbo.users
SET role = 'admin',
    session_version = session_version + 1
WHERE email = LOWER(@email)
  AND role = 'user';

IF @@ROWCOUNT = 0
    PRINT N'No standard user matched that email. Verify the account exists and is not already an admin.';
ELSE
    PRINT N'Account promoted to admin. Sign out and sign back in to refresh the session.';
GO
