-- THE ZAR — server-side access-code redemption template
-- Place this Script in ServerScriptService.
-- IMPORTANT:
-- 1. Replace API_KEY below with the SAME value you saved as Cloudflare's GAME_API_KEY.
-- 2. Never put the key in a LocalScript, ReplicatedStorage, a GUI, or any client-visible object.
-- 3. This validates codes and returns the reward label. Your game must decide what the reward grants.
-- 4. This does not automatically block players from joining the experience.

local HttpService = game:GetService("HttpService")
local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Players = game:GetService("Players")

local API_URL = "https://the-zar-website.klucsik-marton2.workers.dev/api/game/redeem"
local API_KEY = "PASTE_THE_SAME_GAME_API_KEY_HERE"

local remote = ReplicatedStorage:FindFirstChild("ZAR_RedeemCode")
if not remote then
    remote = Instance.new("RemoteFunction")
    remote.Name = "ZAR_RedeemCode"
    remote.Parent = ReplicatedStorage
end

local lastRequestAt = {}
local claimedThisSession = {}

local MIN_REQUEST_INTERVAL = 3

Players.PlayerRemoving:Connect(function(player)
    lastRequestAt[player.UserId] = nil
    claimedThisSession[player.UserId] = nil
end)

remote.OnServerInvoke = function(player, submittedCode)
    if type(submittedCode) ~= "string" then
        return { ok = false, message = "Enter a valid code." }
    end

    local code = submittedCode:match("^%s*(.-)%s*$")
    if #code < 1 or #code > 40 then
        return { ok = false, message = "Enter a valid code." }
    end

    local now = os.clock()
    local previous = lastRequestAt[player.UserId] or 0
    if now - previous < MIN_REQUEST_INTERVAL then
        return { ok = false, message = "Please wait a moment before trying again." }
    end
    lastRequestAt[player.UserId] = now

    if claimedThisSession[player.UserId] then
        return { ok = false, message = "A code has already been redeemed in this server session." }
    end

    if API_KEY == "" or API_KEY == "PASTE_THE_SAME_GAME_API_KEY_HERE" then
        warn("THE ZAR integration: set API_KEY in this ServerScript.")
        return { ok = false, message = "Code redemption is temporarily unavailable." }
    end

    local requestBody = HttpService:JSONEncode({ code = code })
    local success, response = pcall(function()
        return HttpService:RequestAsync({
            Url = API_URL,
            Method = "POST",
            Headers = {
                ["Content-Type"] = "application/json",
                ["Authorization"] = "Bearer " .. API_KEY,
            },
            Body = requestBody,
        })
    end)

    if not success then
        warn("THE ZAR code API request failed:", response)
        return { ok = false, message = "Could not contact The ZAR servers. Try again later." }
    end

    local data
    local decoded, result = pcall(function()
        return HttpService:JSONDecode(response.Body)
    end)
    if decoded then
        data = result
    else
        data = {}
    end

    if not response.Success or data.ok ~= true then
        return {
            ok = false,
            message = type(data.message) == "string" and data.message
                or "That code could not be redeemed.",
        }
    end

    claimedThisSession[player.UserId] = true

    -- TODO: Add your trusted server-side reward/access logic here.
    -- Do not grant valuable rewards from a LocalScript.
    return {
        ok = true,
        type = tostring(data.type or ""),
        reward = tostring(data.reward or "Access approved"),
        message = "Code accepted.",
    }
end
