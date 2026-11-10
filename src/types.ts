export interface UserDataInput {
  email?: string;
  phone?: string;
  first_name?: string;
  last_name?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
  external_id?: string;
  date_of_birth?: string;
  gender?: string;
  fbp?: string;
  fbc?: string;
}

export interface ContentItem {
  id: string;
  quantity: number;
  item_price?: number;
}

export interface CustomData {
  value?: number;
  currency?: string;
  content_ids?: string[];
  content_type?: string;
  content_name?: string;
  content_category?: string;
  contents?: ContentItem[];
  num_items?: number;
  order_id?: string;
  search_string?: string;
  status?: string;
}

export interface ValidEvent {
  event_name: string;
  event_id: string;
  event_time: number;
  event_source_url?: string;
  user: UserDataInput;
  custom_data: CustomData;
  consent: boolean;
}

export interface ServerUserData {
  em?: string[];
  ph?: string[];
  fn?: string[];
  ln?: string[];
  ct?: string[];
  st?: string[];
  zp?: string[];
  country?: string[];
  external_id?: string[];
  db?: string[];
  ge?: string[];
  client_ip_address?: string;
  client_user_agent?: string;
  fbp?: string;
  fbc?: string;
}

export interface ServerEvent {
  event_name: string;
  event_time: number;
  event_id: string;
  event_source_url?: string;
  action_source: "website";
  user_data: ServerUserData;
  custom_data?: CustomData;
}
