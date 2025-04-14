import noblox from "noblox.js";
import dotenv from "dotenv";
import { checkMessage, model } from "./geminiService.js";
import { EmbedBuilder } from "discord.js";
import {
  getSubscription,
  getSubscriptionByGroup,
  getSubscriptionById,
} from "./firebaseService.js";
import { client } from "../bot.js";
dotenv.config();

export async function initializeNoblox() {
  try {
    await noblox.setCookie(process.env.ROBLOX_COOKIE);
    console.log("✅ Noblox.js initialized successfully!");
  } catch (error) {
    console.error("❌ Failed to initialize Noblox.js:", error);
  }
}

export async function getUsername(robloxId) {
  return await noblox.getUsernameFromId(robloxId);
}

export async function getIdFromUsername(username) {
  try {
    return await noblox.getIdFromUsername(username);
  } catch (error) {
    console.error("❌ Failed to fetch user ID:", error);
    return null;
  }
}

export async function getOwnedGroups(robloxId) {
  try {
    const groups = await noblox.getGroups(robloxId);
    const ownedGroups = groups.filter((group) => group.Rank === 255);

    return ownedGroups.map((group) => ({
      id: group.Id.toString(),
      name: group.Name,
    }));
  } catch (error) {
    console.error("❌ Failed to fetch owned groups:", error);
    return false;
  }
}

export async function getGroupInfo(groupId) {
  try {
    const group = await noblox.getGroup(groupId);
    return {
      id: group.id,
      name: group.name,
      memberCount: group.memberCount,
      description: group.description,
    };
  } catch (error) {
    console.error(`❌ Failed to get group info for ${groupId}:`, error);
    return null;
  }
}

export async function verifyGroupOwnership(robloxId, groupId) {
  try {
    const group = await noblox.getGroup(groupId);
    return group.owner && group.owner.userId == robloxId;
  } catch (error) {
    console.error("❌ Failed to verify group ownership:", error);
    return false;
  }
}

/**
 *
 * @param {number | string} groupId
 */
export async function joinRobloxGroup(groupId) {
  const url = `https://groups.roblox.com/v1/groups/${groupId}/users`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `.ROBLOSECURITY=${process.env.ROBLOX_COOKIE}`,
      },
      body: JSON.stringify({
        userId: parseInt(process.env.ROBLOX_ID),
      }),
    });
    if (response.ok) {
      console.log(`✅ Successfully joined group ${groupId}`);
    } else {
      console.error(
        `❌ Failed to join group ${groupId}: ${response.statusText}`
      );
    }
  } catch (error) {
    console.error(`❌ Failed to join group ${groupId}:`, error);
  }
}

export async function getPlayerThumbnail(userIds) {
  noblox.getPlayerThumbnail(userIds);
}

export async function leaveGroup(groupId) {
  try {
    await noblox.leaveGroup(groupId);
  } catch (error) {
    console.log(error);
  }
}

let lastCheckedPostId = null;

// Map to store active monitors by subscription ID
const activeMonitors = new Map();

export async function getNewWallPosts(groupid, limit = 10) {
  try {
    const posts = await noblox.getWall(groupid, "Desc", limit);
    console.log(posts);

    if (!posts.data || posts.data.length === 0) return [];

    const newPosts = posts.data.filter(
      (post) => !lastCheckedPostId || post.id > lastCheckedPostId
    );

    if (newPosts.length > 0) lastCheckedPostId = newPosts[0].id;

    return newPosts.map((post) => ({
      id: post.id,
      body: post.body,
      poster: post.poster,
      created: post.created,
      updated: post.updated,
    }));
  } catch (error) {
    console.error("❌ Error fetching group wall posts:", error);
    return [];
  }
}

function toDiscordTimestamp(date, format = "f") {
  const unixTimestamp = Math.floor(new Date(date).getTime() / 1000);
  return `<t:${unixTimestamp}:${format}>`;
}

export async function checkPosts(groupid, posts) {
  try {
    let moderatedPosts = [];
    const sub = await getSubscriptionByGroup(groupid.toString());
    for (const post of posts) {
      const moderate = await checkMessage(post.body, sub.moderationPrompt);
      if (moderate === true) {
        const pfp = await getPlayerThumbnail(post.poster.user.userId);
        await noblox.deleteWallPost(groupid, post.id);
        const embed = new EmbedBuilder()
          .setAuthor({
            name: post.poster.user.username,
            url: `https://roblox.com/users/${post.poster.user.userId}`,
            iconURL: pfp,
          })
          .setDescription(`Moderated the following post:`)
          .setFields(
            {
              name: "Poster",
              value: `Username: ${post.poster.user.username}\nUser ID: ${post.poster.user.userId}\nUser Role: ${post.poster.role.name} | ${post.poster.role.rank}`,
            },
            {
              name: "Post",
              value: `Post: ${post.body}\nPost ID: ${
                post.id
              }\nPost Created: ${toDiscordTimestamp(
                post.created.toString()
              )}\nPost Edited: ${toDiscordTimestamp(post.updated.toString())}`,
            }
          )
          .setColor(0xe64e4e);
        const channel = await client.channels.fetch(sub.channelId);
        await channel.send({ embeds: [embed] });
        moderatedPosts.push(post);
      } else if (moderate === false) {
        continue;
      }
    }
    return moderatedPosts;
  } catch (error) {
    console.log(error);
  }
}

export function monitorGroupWall(subscriptionId) {
  try {
    // If already monitoring this subscription, stop the existing monitor
    if (activeMonitors.has(subscriptionId)) {
      stopMonitoring(subscriptionId);
    }

    // Set up a function to dynamically retrieve subscription data
    const getSubscriptionData = async () => {
      const subscription = await getSubscriptionById(subscriptionId);
      if (!subscription) {
        console.error(
          `❌ [Subscription ${subscriptionId}] Subscription not found, stopping monitor`
        );
        stopMonitoring(subscriptionId);
        return null;
      }
      return subscription;
    };

    // Initialize the monitor with a periodic check for updated subscription data
    const monitor = {
      subscriptionId,
      intervalId: null,
      posts: null,
    };

    // Start the monitoring process
    const initMonitor = async () => {
      const subscription = await getSubscriptionData();
      if (!subscription) return;

      const { groupId } = subscription;

      // Create the posts event listener
      monitor.posts = noblox.onWallPost(groupId);

      monitor.posts.on("data", async (post) => {
        try {
          // Get fresh subscription data for each post to ensure we have the latest criteria
          const currentSub = await getSubscriptionData();
          if (!currentSub) return;

          const { groupId, moderationCriteria } = currentSub;
          const response = await checkMessage(post.body, moderationCriteria);

          switch (response) {
            case false:
              console.log(
                `✅ [Group ${groupId}] Post ID ${post.id} has not violated auto mod`
              );
              break;
            case true:
              await noblox.deleteWallPost(groupId, post.id);
              const embed = new EmbedBuilder()
                .setAuthor({ name: post.poster.user.username })
                .setDescription(
                  `Post ID: ${post.id}\nPoster: ${post.poster.user.username} (${post.poster.user.userId})\n\nModerated post body: \`\`\`${post.body}\`\`\``
                );
              const channel = await client.channels.fetch(currentSub.channelId);
              await channel.send({ embeds: [embed] });
              break;
            default:
              console.error(
                `❌ [Group ${groupId}] Invalid model response for post ${post.id}:`,
                response
              );
          }
        } catch (error) {
          console.error(
            `❌ [Subscription ${subscriptionId}] Error processing post ${post.id}:`,
            error
          );
        }
      });

      monitor.posts.on("error", (error) => {
        console.error(
          `❌ [Subscription ${subscriptionId}] Wall post monitoring error:`,
          error
        );
      });

      console.log(
        `✅ Monitoring wall posts for subscription ${subscriptionId} (Group ${groupId})`
      );
    };

    // Initialize the monitor
    initMonitor();

    // Store the monitor in our active monitors map
    activeMonitors.set(subscriptionId, monitor);

    return subscriptionId;
  } catch (error) {
    console.error(
      `❌ Failed to initialize wall monitoring for subscription ${subscriptionId}:`,
      error
    );
  }
}

export function stopMonitoring(subscriptionId) {
  try {
    const monitor = activeMonitors.get(subscriptionId);
    if (!monitor) {
      console.log(`No active monitor found for subscription ${subscriptionId}`);
      return false;
    }

    // Clean up the posts event listener if it exists
    if (monitor.posts) {
      monitor.posts.removeAllListeners();
    }

    // Remove from active monitors
    activeMonitors.delete(subscriptionId);
    console.log(`✅ Stopped monitoring for subscription ${subscriptionId}`);
    return true;
  } catch (error) {
    console.error(
      `❌ Error stopping monitor for subscription ${subscriptionId}:`,
      error
    );
    return false;
  }
}

export function getActiveMonitors() {
  return Array.from(activeMonitors.keys());
}

export default {
  initializeNoblox,
  getUsername,
  getIdFromUsername,
  getOwnedGroups,
  verifyGroupOwnership,
  joinRobloxGroup,
  monitorGroupWall,
  stopMonitoring,
  getActiveMonitors,
  getGroupInfo,
  getPlayerThumbnail,
  leaveGroup,
};
