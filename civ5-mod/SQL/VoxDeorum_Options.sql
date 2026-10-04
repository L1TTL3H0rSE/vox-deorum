UPDATE CustomModOptions	SET Value = 1 WHERE Name = 'IPC_CHANNEL';
UPDATE CustomModOptions	SET Value = 1 WHERE Name like 'EVENTS_%';

INSERT INTO Flavors
	(Type)
VALUES
	('FLAVOR_MOBILIZATION');

-- Vox Deorum: the five tactical flavors that steer tactical search (0..10 personality scale, like other flavors)
INSERT INTO Flavors
	(Type)
VALUES
	('FLAVOR_RISK'),
	('FLAVOR_OCCUPATION'),
	('FLAVOR_ATTRITION'),
	('FLAVOR_HOLD_CITY'),
	('FLAVOR_HOLD_GROUND');
-- A leader without FLAVOR_RISK takes it from its offense flavor in the DLL (see GetGeneralTacticalFlavors).