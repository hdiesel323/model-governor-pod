-- factory-hub#78 follow-up: prioritise probing by the model's real release date; retire non-chat/router/batch rows.
ALTER TABLE model_catalog ADD COLUMN model_created_at INTEGER;
UPDATE model_catalog SET lifecycle = 'retired'
  WHERE source = 'discovered' AND (model_name LIKE '%:batch' OR model_name LIKE 'openrouter/%' OR model_name LIKE '%lyria%');
