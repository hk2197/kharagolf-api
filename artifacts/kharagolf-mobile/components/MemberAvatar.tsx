import React from "react";
import { Image, Text, View } from "react-native";
import { SvgXml } from "react-native-svg";
import { PRESET_MAP, isPresetAvatar, getPresetId } from "@/constants/avatarPresets";

interface Props {
  profileImage: string | null | undefined;
  firstName: string;
  lastName: string;
  size?: number;
}

export default function MemberAvatar({ profileImage, firstName, lastName, size = 36 }: Props) {
  const radius = size / 2;
  const fontSize = size * 0.35;

  if (isPresetAvatar(profileImage)) {
    const preset = PRESET_MAP[getPresetId(profileImage as string)];
    if (preset) {
      return (
        <View style={{ width: size, height: size, borderRadius: radius, overflow: "hidden" }}>
          <SvgXml xml={preset.svgXml} width={size} height={size} />
        </View>
      );
    }
  }

  if (profileImage && profileImage.startsWith("http")) {
    return (
      <Image
        source={{ uri: profileImage }}
        style={{ width: size, height: size, borderRadius: radius }}
        resizeMode="cover"
      />
    );
  }

  const initials = `${(firstName?.[0] ?? "?").toUpperCase()}${(lastName?.[0] ?? "").toUpperCase()}`;
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: radius,
        backgroundColor: "#1a3a2a",
        alignItems: "center",
        justifyContent: "center",
        borderWidth: 1,
        borderColor: "rgba(201,168,76,0.3)",
      }}
    >
      <Text style={{ color: "#C9A84C", fontSize, fontWeight: "700", letterSpacing: 0.5 }}>
        {initials}
      </Text>
    </View>
  );
}
