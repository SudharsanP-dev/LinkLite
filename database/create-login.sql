-- Creates a limited SQL login for the Node.js app (better than using "sa").
-- In SSMS, use this as a template in a new, unsaved query window. Replace the
-- placeholder there with a strong password; never save or commit that query.
-- Put the same password in the local, git-ignored .env file.

USE master;
GO
IF NOT EXISTS (SELECT 1 FROM sys.server_principals WHERE name = N'linklite_user')
    CREATE LOGIN linklite_user WITH PASSWORD = N'REPLACE_WITH_A_STRONG_SQL_PASSWORD', CHECK_POLICY = ON;
ELSE
    PRINT N'linklite_user already exists. Change its password separately with ALTER LOGIN if needed.';
GO

USE linklite;
GO
IF NOT EXISTS (SELECT 1 FROM sys.database_principals WHERE name = N'linklite_user')
    CREATE USER linklite_user FOR LOGIN linklite_user;
GO
-- The app only needs to read and write rows.
ALTER ROLE db_datareader ADD MEMBER linklite_user;
ALTER ROLE db_datawriter ADD MEMBER linklite_user;
GO
